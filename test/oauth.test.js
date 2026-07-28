"use strict";

// The OAuth authorization flow's CSRF protection.
//
// Both strategies are constructed with `state: true`. Without it passport-oauth2
// installs a NullStore and verifies nothing, so an authorization code issued to
// one session is accepted by any other — an attacker can hand a victim their own
// callback URL and silently sign that victim into the ATTACKER's account.
//
// These tests never talk to Google or Discord. passport-oauth2 verifies the
// state BEFORE it exchanges the code (strategy.js `loaded`: a failed verify
// returns fail() and the token request is never made), so every assertion below
// resolves inside our own process.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const helpers = require("./helpers");

// Must be set before the app's config is read. Credentials only need to be
// non-empty — config.google.enabled is a truthiness check, and no request ever
// reaches the provider.
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-secret";
process.env.DATA_DIR = helpers.tempDataDir();
process.env.GOOGLE_CLIENT_ID = "test-google-client";
process.env.GOOGLE_CLIENT_SECRET = "test-google-secret";
process.env.DISCORD_CLIENT_ID = "test-discord-client";
process.env.DISCORD_CLIENT_SECRET = "test-discord-secret";

const { startTestServer, get } = helpers;

let srv;
before(async () => {
  srv = await startTestServer();
});
after(() => srv.close());

const cookieFrom = (res) => (res.headers["set-cookie"] || []).map((c) => c.split(";")[0]).join("; ");

// Begin an authorization request and return what the provider would have seen,
// plus the session cookie that is supposed to be bound to it.
async function startFlow(provider) {
  const res = await get(srv.port, `/auth/${provider}`);
  assert.equal(res.status, 302, `/auth/${provider} should redirect to the provider`);
  return { location: new URL(res.headers.location), cookie: cookieFrom(res) };
}

for (const [provider, host] of [
  ["google", "accounts.google.com"],
  ["discord", "discord.com"],
]) {
  test(`the ${provider} authorization redirect carries a state parameter`, async () => {
    const { location, cookie } = await startFlow(provider);

    assert.equal(location.host, host);
    const state = location.searchParams.get("state");
    assert.ok(state, "no state parameter — passport is using a NullStore and verifies nothing");
    assert.ok(state.length >= 16, `state is too short to be unguessable: ${JSON.stringify(state)}`);
    assert.ok(cookie, "the state has to be persisted in the session to be verifiable later");
  });

  test(`a ${provider} callback whose state doesn't match the session is refused`, async () => {
    const { location, cookie } = await startFlow(provider);
    const realState = location.searchParams.get("state");

    const res = await get(srv.port, `/auth/${provider}/callback?code=stolen-code&state=forged-${realState}`, cookie);

    // fail() → the route's failureRedirect. A 500 here would mean we reached the
    // token exchange, which is exactly what state is supposed to prevent.
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, "/?error=auth_failed");

    // And it must not have signed anyone in as a side effect.
    const me = await get(srv.port, "/auth/me", cookie);
    assert.equal(JSON.parse(me.body).user, null, "a refused callback must leave the session anonymous");
  });

  test(`a ${provider} callback with no authorization request behind it is refused`, async () => {
    // The attack shape: a victim who never started a sign-in loads a callback
    // URL. There is no stored state for their session, so there is nothing the
    // supplied one can legitimately match.
    const res = await get(srv.port, `/auth/${provider}/callback?code=stolen-code&state=anything`);

    assert.equal(res.status, 302);
    assert.equal(res.headers.location, "/?error=auth_failed");
  });
}

test("each provider gets its own state slot, so one flow can't satisfy the other", async () => {
  const google = await startFlow("google");
  const discord = await startFlow("discord");

  // Two independent sessions here, but the keys are per-provider hostname, so
  // even a single session running both flows keeps them separate.
  assert.notEqual(google.location.searchParams.get("state"), discord.location.searchParams.get("state"));

  // A Google state presented to the Discord callback is not a match.
  const res = await get(
    srv.port,
    `/auth/discord/callback?code=stolen-code&state=${google.location.searchParams.get("state")}`,
    discord.cookie
  );
  assert.equal(res.headers.location, "/?error=auth_failed");
});
