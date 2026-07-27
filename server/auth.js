"use strict";

const express = require("express");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const DiscordStrategy = require("passport-discord").Strategy;
const { customAlphabet } = require("nanoid");

const config = require("./config");
const { upsertOAuthUser, getUserById, getUserRatings } = require("./db");
const { tierFor } = require("./elo");
const { LADDERS } = require("./ladders");

const guestSuffix = customAlphabet("0123456789", 4);

// ── Passport session (de)serialization ──────────────────────────────────────
// We serialize the numeric DB id for OAuth users. Guests never touch passport;
// their identity lives directly on the session (req.session.guest).
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
  try {
    done(null, getUserById(id) || false);
  } catch (err) {
    done(err);
  }
});

function configurePassport() {
  if (config.google.enabled) {
    passport.use(
      new GoogleStrategy(
        {
          clientID: config.google.clientId,
          clientSecret: config.google.clientSecret,
          callbackURL: `${config.baseUrl}/auth/google/callback`,
        },
        (accessToken, refreshToken, profile, done) => {
          try {
            const user = upsertOAuthUser({
              provider: "google",
              providerId: profile.id,
              displayName: profile.displayName || (profile.name && profile.name.givenName) || "Player",
              avatarUrl: profile.photos && profile.photos[0] && profile.photos[0].value,
            });
            done(null, user);
          } catch (err) {
            done(err);
          }
        }
      )
    );
  }

  if (config.discord.enabled) {
    passport.use(
      new DiscordStrategy(
        {
          clientID: config.discord.clientId,
          clientSecret: config.discord.clientSecret,
          callbackURL: `${config.baseUrl}/auth/discord/callback`,
          scope: ["identify"],
        },
        (accessToken, refreshToken, profile, done) => {
          try {
            const avatar = profile.avatar
              ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png`
              : null;
            const user = upsertOAuthUser({
              provider: "discord",
              providerId: profile.id,
              displayName: profile.global_name || profile.username || "Player",
              avatarUrl: avatar,
            });
            done(null, user);
          } catch (err) {
            done(err);
          }
        }
      )
    );
  }
}

function accountIdentity(user) {
  const raw = getUserRatings(user.id);
  const ratings = {};
  for (const mode of LADDERS) {
    const r = raw[mode];
    const tier = tierFor(r.rating);
    ratings[mode] = {
      rating: r.rating,
      tier: tier.name,
      tierIcon: tier.icon,
      wins: r.wins,
      losses: r.losses,
      draws: r.draws,
      gamesPlayed: r.games_played,
    };
  }
  return {
    kind: "account",
    id: `u${user.id}`,
    userId: user.id,
    name: user.display_name,
    avatar: user.avatar_url || null,
    ranked: true,
    ratings,
  };
}

function guestIdentity(guest) {
  return { kind: "guest", id: guest.id, name: guest.name, avatar: null, ranked: false };
}

// Build a unified identity straight from a session object. Works outside the
// Express request cycle (e.g. Socket.IO handshakes), where passport hasn't run.
function identityFromSession(session) {
  if (!session) return null;
  const passportId = session.passport && session.passport.user;
  if (passportId != null) {
    const user = getUserById(passportId);
    if (user) return accountIdentity(user);
  }
  if (session.guest) return guestIdentity(session.guest);
  return null;
}

// Unified identity for the rest of the app. Returns null if not signed in.
function getSessionUser(req) {
  if (req.user) return accountIdentity(req.user);
  if (req.session && req.session.guest) return guestIdentity(req.session.guest);
  return null;
}

const router = express.Router();

function providerStart(name) {
  return (req, res, next) => {
    const enabled = name === "google" ? config.google.enabled : config.discord.enabled;
    if (!enabled) return res.redirect("/?error=oauth_unconfigured");
    passport.authenticate(name)(req, res, next);
  };
}

router.get("/auth/google", providerStart("google"));
router.get(
  "/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/?error=auth_failed" }),
  (req, res) => res.redirect("/")
);

router.get("/auth/discord", providerStart("discord"));
router.get(
  "/auth/discord/callback",
  passport.authenticate("discord", { failureRedirect: "/?error=auth_failed" }),
  (req, res) => res.redirect("/")
);

// Play as guest: casual & private rooms only, no ranked.
router.post("/auth/guest", express.json(), (req, res) => {
  let name = String((req.body && req.body.name) || "").trim().slice(0, 20);
  if (!name) name = "Guest";
  name = name.replace(/[<>]/g, "");
  req.session.guest = { id: `g_${guestSuffix()}_${Date.now().toString(36)}`, name: `${name}#${guestSuffix()}` };
  res.json({ ok: true, user: getSessionUser(req) });
});

router.post("/auth/logout", (req, res, next) => {
  const finish = () => {
    if (req.session) {
      req.session.guest = null;
      return req.session.save(() => res.json({ ok: true }));
    }
    res.json({ ok: true });
  };
  if (req.logout) return req.logout((err) => (err ? next(err) : finish()));
  finish();
});

// Current identity + which auth methods are available.
router.get("/auth/me", (req, res) => {
  res.json({
    user: getSessionUser(req),
    providers: { google: config.google.enabled, discord: config.discord.enabled },
  });
});

module.exports = { configurePassport, getSessionUser, identityFromSession, router };
