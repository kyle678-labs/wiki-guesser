"use strict";

const express = require("express");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const DiscordStrategy = require("passport-discord").Strategy;
const { customAlphabet } = require("nanoid");

const config = require("./config");
const { upsertOAuthUser, getUserById, getUserRatings, touchSeen, activeBan } = require("./db");
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
          // Required: passport-google-oauth20 sets no default scope, and Google
          // rejects an authorization request without one. "profile" alone is
          // also all we need — we deliberately don't request "email", and the
          // privacy policy says so.
          scope: ["profile"],
          // See the note on OAUTH_STATE below. Without this, passport-oauth2
          // installs a NullStore and the callback is never bound to the session
          // that started the flow.
          state: true,
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
          state: true, // see the note on OAUTH_STATE below
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
  // Every path that resolves an account runs through here — HTTP requests and
  // socket handshakes alike — which makes it the one place that sees the full
  // picture of "this player is active". The write is throttled inside touchSeen.
  touchSeen(user.id);
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
    // Default ON: the column defaults to 1, and a null from a row written before
    // the migration should also read as "chat visible".
    chatEnabled: user.chat_enabled !== 0,
    // { reason, until, at } while a ban is in force, null otherwise. Resolved
    // here rather than at each enforcement point so there is ONE definition of
    // "this player is banned" — the socket handshake, the daily routes and the
    // browser all read this same field, and an expired ban stops applying
    // everywhere at once. One indexed lookup on a small table, on a path that
    // already reads the user row and their ratings.
    banned: activeBan(user.id),
    ratings,
  };
}

// Guests have no account row, so their chat preference rides on the session
// instead — which still survives closing the tab and rejoining a later game,
// because the session cookie lasts 30 days.
function guestIdentity(guest) {
  return {
    kind: "guest",
    id: guest.id,
    name: guest.name,
    avatar: null,
    ranked: false,
    chatEnabled: guest.chatEnabled !== false,
  };
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

// ── OAUTH_STATE ──────────────────────────────────────────────────────────────
// Both strategies are constructed with `state: true`, which is what binds the
// provider's callback to the session that began the flow.
//
// Without it passport-oauth2 falls back to a NullStore and verifies nothing, so
// an authorization code from ANY session is accepted by ANY other. That is a
// login CSRF: an attacker starts their own sign-in, captures their callback URL,
// and gets a victim to load it — the victim's browser silently ends up signed
// into the ATTACKER's account, and every game they then play, along with their
// ratings and match history, accrues to an account someone else controls.
//
// `state: true` requires session support, which is why the session middleware is
// registered before this router in app.js. A mismatched or missing state makes
// the strategy fail() rather than error(), so it lands on the failureRedirect
// below and the player just sees a failed sign-in.
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
