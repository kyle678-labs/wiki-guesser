/* Admin dashboard.
 *
 * Deliberately dumb, in the same way public/js/daily.js is: every decision —
 * who counts as an admin, what a report says, whether a ban is still in force —
 * is made by the server and this file renders the answer. Nothing here is a
 * check, because a check in a page served only to admins protects nobody.
 *
 * Served from server/admin/ rather than public/, so it is behind the allowlist
 * along with the data it displays. It reuses /js/common.js for the theme,
 * escaping and toasts, and never opens a socket.
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => WG.escapeHtml(s == null ? "" : s);

  WG.initTheme();

  // How often the overview re-reads itself. Long enough to stay well inside the
  // /api rate limit while the tab sits open all day, short enough that "right
  // now" means it.
  const REFRESH_MS = 20000;
  let refreshTimer = null;
  let tab = "overview";
  let reportStatus = "open";

  // ── Plumbing ───────────────────────────────────────────────────────────────

  async function api(path, opts = {}) {
    const res = await fetch(path, { credentials: "same-origin", ...opts });
    // A 404 here means the session stopped being an admin mid-session — the
    // allowlist changed and the process restarted under us. Say so rather than
    // rendering an empty dashboard that looks like "no reports".
    if (res.status === 404) throw new Error("This session is no longer an admin — check ADMIN_USER_IDS.");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
    return data;
  }

  function fail(el, err) {
    console.error(err);
    el.innerHTML = `<div class="card"><p class="red">${esc(err.message)}</p></div>`;
  }

  const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;

  // Relative for anything recent, absolute once "4 days ago" stops being the
  // useful form. The exact stamp is always on the title attribute.
  function ago(ms) {
    if (!ms) return "—";
    const d = Date.now() - ms;
    if (d < MIN) return "just now";
    if (d < HOUR) return `${Math.floor(d / MIN)} min ago`;
    if (d < DAY) return `${Math.floor(d / HOUR)}h ago`;
    if (d < 7 * DAY) return `${Math.floor(d / DAY)}d ago`;
    return new Date(ms).toISOString().slice(0, 10);
  }
  const when = (ms) => (ms ? new Date(ms).toLocaleString() : "");
  const stamp = (ms) => `<span title="${esc(when(ms))}">${esc(ago(ms))}</span>`;

  // A ban's remaining life, from the client's own clock. The server decides
  // whether it is in force; this only says how it reads.
  function untilLabel(until) {
    if (until == null) return "permanent";
    const left = until - Date.now();
    if (left <= 0) return "expired";
    if (left < HOUR) return `${Math.max(1, Math.ceil(left / MIN))} min left`;
    if (left < DAY) return `${Math.ceil(left / HOUR)}h left`;
    return `${Math.ceil(left / DAY)}d left`;
  }

  // ── Tabs ───────────────────────────────────────────────────────────────────

  function showTab(next) {
    tab = next;
    document.querySelectorAll("#admin-tabs .board-tab").forEach((b) =>
      b.classList.toggle("active", b.dataset.tab === next)
    );
    document.querySelectorAll(".admin-pane").forEach((p) =>
      p.classList.toggle("hidden", p.id !== `pane-${next}`)
    );
    // Only the overview polls. The other three are worked through by hand, and
    // a list that reshuffles under the cursor mid-click is worse than a stale
    // one you refreshed yourself.
    clearInterval(refreshTimer);
    refreshTimer = null;
    if (next === "overview") {
      loadOverview();
      refreshTimer = setInterval(loadOverview, REFRESH_MS);
    }
    if (next === "reports") loadReports();
    if (next === "bans") loadBans();
    if (next === "notices") loadNotices();
  }

  document.querySelectorAll("#admin-tabs .board-tab").forEach((b) =>
    b.addEventListener("click", () => showTab(b.dataset.tab))
  );

  // ── Overview ───────────────────────────────────────────────────────────────

  const stat = (label, value, note) =>
    `<div class="stat"><div class="stat-value">${esc(value)}</div>
      <div class="stat-label">${esc(label)}</div>
      ${note ? `<div class="stat-note">${esc(note)}</div>` : ""}</div>`;

  async function loadOverview() {
    try {
      const d = await api("/api/admin/overview");
      $("admin-me").textContent = `${d.me.name} · #${d.me.id}`;

      const s = d.stats;
      const dailies = Object.values(s.dailyPlaysToday).reduce((a, b) => a + b, 0);
      $("stat-grid").innerHTML = [
        stat("Open reports", s.reports.open, `${s.reports.actioned} actioned · ${s.reports.dismissed} dismissed`),
        stat("Active bans", s.activeBans),
        stat("Accounts", s.accounts, `+${s.accountsNew7d} this week`),
        stat("Active today", s.activeToday, `${s.active7d} this week`),
        stat("Playing now", d.live.activeRooms, `${d.live.sockets} sockets · ${d.live.rooms.length} rooms`),
        stat("Ranked matches", s.rankedMatches, `${s.rankedMatches7d} this week`),
        stat("Daily plays today", dailies, Object.entries(s.dailyPlaysToday).map(([g, n]) => `${g} ${n}`).join(" · ")),
      ].join("");

      // The report tab carries its count, so an open queue is visible from
      // whichever tab you happen to be sitting on.
      setReportBadge(s.reports.open);

      renderLive(d.live);
      renderProcess(d.process);
      $("signups-body").innerHTML =
        d.signups
          .map(
            (u) => `<tr>
              <td>${u.id}</td>
              <td><div class="who">${WG.avatarHtml(u.name, u.avatar, "sm")} ${esc(u.name)}</div></td>
              <td class="muted">${esc(u.provider)}</td>
              <td>${stamp(u.createdAt)}</td>
              <td>${stamp(u.lastSeen)}</td>
            </tr>`
          )
          .join("") || `<tr><td colspan="5" class="muted">No accounts yet.</td></tr>`;
    } catch (err) {
      fail($("stat-grid"), err);
      clearInterval(refreshTimer);
    }
  }

  function renderLive(live) {
    const queues = live.queues.length
      ? `<div class="admin-rows">` +
        live.queues
          .map(
            (q) => `<div class="admin-row">
              <span class="mono">${esc(q.key)}</span>
              <span>${q.waiting} waiting</span>
              <span class="muted">longest ${Math.round(q.oldestMs / 1000)}s</span>
            </div>`
          )
          .join("") +
        `</div>`
      : `<p class="muted">Nobody in the queues.</p>`;

    const rooms = live.rooms.length
      ? `<div class="admin-rows">` +
        live.rooms
          .map(
            (r) => `<div class="admin-row">
              <span class="mono">${esc(r.code)}</span>
              <span>${esc(r.isPrivate ? "private" : r.ranked ? "ranked" : "casual")} · ${esc(r.clue)} · ${esc(r.tier)}</span>
              <span class="muted">${esc(r.phase)}${r.round ? ` · round ${r.round}/${r.rounds}` : ""}</span>
              <span class="muted">${r.players.map((p) => esc(p.name) + (p.connected ? "" : " (gone)")).join(", ")}</span>
            </div>`
          )
          .join("") +
        `</div>`
      : `<p class="muted">No rooms open.</p>`;

    $("live-card").innerHTML = `<h3>Queues</h3>${queues}<h3 style="margin-top:1rem">Rooms</h3>${rooms}`;
  }

  function renderProcess(p) {
    const hours = Math.floor(p.uptime / 3600);
    const mins = Math.floor((p.uptime % 3600) / 60);
    $("process-card").innerHTML = `<div class="admin-rows">
      <div class="admin-row"><span>Version</span><span class="mono">${esc(p.version)}</span><span class="muted">${esc(p.env)}</span></div>
      <div class="admin-row"><span>Uptime</span><span>${hours}h ${mins}m</span></div>
      <div class="admin-row"><span>Event loop lag</span><span>p50 ${p.loopLagP50Ms}ms · p99 ${p.loopLagP99Ms}ms</span>
        <span class="muted">max ${p.loopLagMaxMs}ms — the leading indicator, watch p99</span></div>
      <div class="admin-row"><span>Memory</span><span>${p.rssMb} MB RSS · ${p.heapUsedMb} MB heap</span></div>
    </div>`;
  }

  // ── Reports ────────────────────────────────────────────────────────────────

  document.querySelectorAll("#report-filters .board-tab").forEach((b) =>
    b.addEventListener("click", () => {
      reportStatus = b.dataset.status;
      document.querySelectorAll("#report-filters .board-tab").forEach((x) => x.classList.toggle("active", x === b));
      loadReports();
    })
  );

  // The badge lives on the tab, so it has to be right from whichever tab is
  // showing. Both the overview poll and every report list carry the counts.
  function setReportBadge(open) {
    $("tab-report-count").textContent = open ? open : "";
    $("tab-report-count").classList.toggle("hidden", !open);
  }

  async function loadReports() {
    const el = $("reports-list");
    try {
      const { reports, counts } = await api(`/api/admin/reports?status=${encodeURIComponent(reportStatus)}`);
      setReportBadge(counts.open);
      if (!reports.length) {
        el.innerHTML = `<div class="card"><p class="muted">Nothing ${
          reportStatus === "open" ? "waiting" : `marked ${esc(reportStatus)}`
        }.</p></div>`;
        return;
      }
      el.innerHTML = reports.map(reportCard).join("");
    } catch (err) {
      fail(el, err);
    }
  }

  function reportCard(r) {
    // The reported message is rendered as text inside a quote block, never as
    // markup — it is the one string on this page written by somebody we are
    // looking at precisely because they may be acting in bad faith.
    const banState = r.authorBan
      ? `<span class="tag tag-ban">suspended · ${esc(untilLabel(r.authorBan.until))}</span>`
      : r.author.userId
      ? ""
      : `<span class="tag">guest — nothing to suspend</span>`;

    const actions =
      r.status === "open"
        ? `<div class="report-actions">
            <input type="text" class="report-note" placeholder="Note (optional)" maxlength="500" />
            <button class="small" data-resolve="dismissed" data-id="${r.id}">Dismiss</button>
            <button class="small danger" data-resolve="actioned" data-id="${r.id}">Mark actioned</button>
            ${r.author.userId && !r.authorBan
              ? `<button class="small" data-ban="${r.author.userId}" data-name="${esc(r.author.name)}">Suspend author…</button>`
              : ""}
          </div>`
        : `<p class="hint">${esc(r.status)} ${esc(ago(r.resolvedAt))}${r.note ? ` — “${esc(r.note)}”` : ""}</p>`;

    return `<div class="card report" data-report="${r.id}">
      <div class="report-head">
        <div>
          <strong>${esc(r.author.name)}</strong>
          ${r.author.userId ? `<button class="linkish" data-player="${r.author.userId}">#${r.author.userId}</button>` : ""}
          ${banState}
        </div>
        <div class="hint">${stamp(r.at)} · room <span class="mono">${esc(r.room)}</span>
          · ${esc(r.isPrivate ? "private" : r.ranked ? "ranked" : "casual")}</div>
      </div>
      <blockquote class="report-msg">${esc(r.message.text)}</blockquote>
      <p class="hint">Reported by ${esc(r.reporter.name)}${
        r.reporter.userId ? ` (#${r.reporter.userId})` : " (guest)"
      } · message sent ${esc(ago(r.message.at))}</p>
      ${actions}
    </div>`;
  }

  // Delegated: the list is rebuilt on every action, so per-button listeners
  // would have to be rewired each time.
  $("reports-list").addEventListener("click", async (e) => {
    const resolve = e.target.closest("[data-resolve]");
    const ban = e.target.closest("[data-ban]");
    const player = e.target.closest("[data-player]");

    if (player) return openPlayer(player.dataset.player);
    if (ban) return showTab("players"), openPlayer(ban.dataset.ban);
    if (!resolve) return;

    const card = resolve.closest(".report");
    const note = card.querySelector(".report-note");
    resolve.disabled = true;
    try {
      const { changed } = await api(`/api/admin/reports/${resolve.dataset.id}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: resolve.dataset.resolve, note: note ? note.value.trim() : "" }),
      });
      WG.toast(changed ? `Marked ${resolve.dataset.resolve}.` : "That report was already closed.");
      loadReports();
    } catch (err) {
      resolve.disabled = false;
      WG.toast(err.message);
    }
  });

  // ── Bans ───────────────────────────────────────────────────────────────────

  async function loadBans() {
    const el = $("bans-list");
    try {
      const { bans } = await api("/api/admin/bans");
      if (!bans.length) {
        el.innerHTML = `<div class="card"><p class="muted">Nobody is suspended.</p></div>`;
        return;
      }
      el.innerHTML =
        `<div class="card"><table class="board">
          <thead><tr><th>Player</th><th>State</th><th>Reason</th><th>By</th><th></th></tr></thead><tbody>` +
        bans
          .map(
            (b) => `<tr>
              <td><div class="who">${WG.avatarHtml(b.name, b.avatar, "sm")}
                <button class="linkish" data-player="${b.userId}">${esc(b.name)}</button></div></td>
              <td>${b.active ? `<span class="tag tag-ban">${esc(untilLabel(b.until))}</span>` : `<span class="tag">expired</span>`}</td>
              <td>${esc(b.reason || "—")}</td>
              <td class="muted">${esc(b.byName || "—")} · ${stamp(b.at)}</td>
              <td><button class="small" data-unban="${b.userId}">Lift</button></td>
            </tr>`
          )
          .join("") +
        `</tbody></table></div>`;
    } catch (err) {
      fail(el, err);
    }
  }

  $("bans-list").addEventListener("click", async (e) => {
    const player = e.target.closest("[data-player]");
    if (player) return showTab("players"), openPlayer(player.dataset.player);
    const unban = e.target.closest("[data-unban]");
    if (!unban) return;
    unban.disabled = true;
    try {
      await api(`/api/admin/bans/${unban.dataset.unban}`, { method: "DELETE" });
      WG.toast("Suspension lifted.");
      loadBans();
    } catch (err) {
      unban.disabled = false;
      WG.toast(err.message);
    }
  });

  // ── Notices ────────────────────────────────────────────────────────────────

  function renderNotices(notices) {
    const el = $("notices-list");
    const live = notices.filter((n) => n.active).length;
    $("notice-count").textContent = live
      ? `${live} notice${live === 1 ? "" : "s"} showing on the site right now.`
      : "Nothing pinned — visitors see no notices.";

    if (!notices.length) {
      el.innerHTML = `<div class="card"><p class="muted">No notices yet.</p></div>`;
      return;
    }
    el.innerHTML =
      `<div class="card"><table class="board">
        <thead><tr><th>Message</th><th>Level</th><th>State</th><th>Pinned</th><th></th></tr></thead><tbody>` +
      notices
        .map(
          (n) => `<tr>
            <td>${esc(n.message)}</td>
            <td>${n.level === "warn" ? `<span class="tag tag-ban">important</span>` : `<span class="tag">info</span>`}</td>
            <td>${n.active
              ? `<span class="tag tag-live">${n.expiresAt ? esc(untilLabel(n.expiresAt)) : "showing"}</span>`
              : `<span class="tag">expired</span>`}</td>
            <td>${stamp(n.at)}</td>
            <td><button class="small" data-unpin="${n.id}">Unpin</button></td>
          </tr>`
        )
        .join("") +
      `</tbody></table></div>`;
  }

  async function loadNotices() {
    try {
      renderNotices((await api("/api/admin/notices")).notices);
    } catch (err) {
      fail($("notices-list"), err);
    }
  }

  $("notice-pin").addEventListener("click", async () => {
    const btn = $("notice-pin");
    const msg = $("notice-msg").value.trim();
    if (!msg) return WG.toast("Type a message first.");
    btn.disabled = true;
    try {
      // The response carries the new list, so pinning does not need a second
      // round trip to show what it did.
      const { notices } = await api("/api/admin/notices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: msg,
          level: $("notice-level").value,
          days: $("notice-days").value === "" ? null : Number($("notice-days").value),
        }),
      });
      $("notice-msg").value = "";
      renderNotices(notices);
      WG.toast("Pinned — it is live now.");
    } catch (err) {
      WG.toast(err.message);
    } finally {
      btn.disabled = false;
    }
  });

  $("notice-msg").addEventListener("keydown", (e) => { if (e.key === "Enter") $("notice-pin").click(); });

  $("notices-list").addEventListener("click", async (e) => {
    const unpin = e.target.closest("[data-unpin]");
    if (!unpin) return;
    unpin.disabled = true;
    try {
      const { notices } = await api(`/api/admin/notices/${unpin.dataset.unpin}`, { method: "DELETE" });
      renderNotices(notices);
      WG.toast("Unpinned.");
    } catch (err) {
      unpin.disabled = false;
      WG.toast(err.message);
    }
  });

  // ── Players ────────────────────────────────────────────────────────────────

  async function searchPlayers() {
    const q = $("player-q").value.trim();
    const el = $("players-result");
    $("player-detail").innerHTML = "";
    if (!q) { el.innerHTML = ""; return; }
    try {
      const { players } = await api(`/api/admin/players?q=${encodeURIComponent(q)}`);
      el.innerHTML = players.length
        ? `<div class="card"><table class="board">
            <thead><tr><th>#</th><th>Player</th><th>Via</th><th>Last seen</th><th>State</th></tr></thead><tbody>` +
          players
            .map(
              (p) => `<tr>
                <td>${p.id}</td>
                <td><div class="who">${WG.avatarHtml(p.name, p.avatar, "sm")}
                  <button class="linkish" data-player="${p.id}">${esc(p.name)}</button></div></td>
                <td class="muted">${esc(p.provider)}</td>
                <td>${stamp(p.lastSeen)}</td>
                <td>${p.ban ? `<span class="tag tag-ban">${esc(untilLabel(p.ban.until))}</span>` : ""}</td>
              </tr>`
            )
            .join("") +
          `</tbody></table></div>`
        : `<div class="card"><p class="muted">No accounts match that.</p></div>`;
    } catch (err) {
      fail(el, err);
    }
  }

  $("player-search").addEventListener("click", searchPlayers);
  $("player-q").addEventListener("keydown", (e) => { if (e.key === "Enter") searchPlayers(); });
  $("players-result").addEventListener("click", (e) => {
    const p = e.target.closest("[data-player]");
    if (p) openPlayer(p.dataset.player);
  });

  async function openPlayer(id) {
    const el = $("player-detail");
    el.innerHTML = `<div class="card"><p class="muted">Loading…</p></div>`;
    try {
      const { player } = await api(`/api/admin/players/${encodeURIComponent(id)}`);
      el.innerHTML = playerCard(player);
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (err) {
      fail(el, err);
    }
  }

  function playerCard(p) {
    const ratings = p.ratings.length
      ? p.ratings
          .map((r) => `<div class="admin-row"><span class="mono">${esc(r.mode)}</span>
            <span>${r.rating}</span>
            <span class="muted">${r.games_played} games · ${r.wins}/${r.losses}/${r.draws}</span></div>`)
          .join("")
      : `<p class="muted">No ranked games.</p>`;

    const matches = p.matches.length
      ? p.matches
          .map((m) => `<div class="admin-row"><span class="mono">${esc(m.mode)}</span>
            <span>${esc(m.result)} vs ${esc(m.opponent)}</span>
            <span class="muted">${m.myScore}–${m.theirScore} · ${m.delta >= 0 ? "+" : ""}${m.delta} → ${m.ratingAfter}</span>
            <span class="muted">${ago(m.at)}</span></div>`)
          .join("")
      : `<p class="muted">No ranked games.</p>`;

    const reports = p.recentReports.length
      ? p.recentReports
          .map((r) => `<div class="admin-row"><span class="muted">${esc(ago(r.at))}</span>
            <blockquote class="report-msg inline">${esc(r.message.text)}</blockquote>
            <span class="tag">${esc(r.status)}</span></div>`)
          .join("")
      : `<p class="muted">Never reported.</p>`;

    // The ban control. An admin account shows no control at all rather than one
    // that errors when pressed — the server refuses it either way, but a button
    // that cannot work should not be offered.
    let control;
    if (p.isAdmin) {
      control = `<p class="hint">This account is an admin. Remove it from ADMIN_USER_IDS to suspend it.</p>`;
    } else if (p.ban) {
      control = `<p><span class="tag tag-ban">Suspended · ${esc(untilLabel(p.ban.until))}</span>
          ${p.ban.reason ? ` — ${esc(p.ban.reason)}` : ""}</p>
        <button class="small" data-unban="${p.id}">Lift suspension</button>`;
    } else {
      control = `<div class="ban-form">
        <input type="text" id="ban-reason" maxlength="500" placeholder="Reason (shown to the player)" />
        <select id="ban-days">
          <option value="1">1 day</option>
          <option value="7" selected>7 days</option>
          <option value="30">30 days</option>
          <option value="">Permanent</option>
        </select>
        <button class="danger" id="ban-go" data-user="${p.id}">Suspend for 7 days</button>
      </div>
      <p class="hint">They are dropped from any game they are in, and cannot queue, chat or play a daily until it lifts.</p>`;
    }

    return `<div class="card player-detail">
      <div class="report-head">
        <div class="who">${WG.avatarHtml(p.name, p.avatar)} <strong>${esc(p.name)}</strong>
          <span class="muted">#${p.id} · ${esc(p.provider)}</span></div>
        <div class="hint">joined ${esc(ago(p.createdAt))} · last seen ${esc(ago(p.lastSeen))}</div>
      </div>
      <p class="hint">Reported ${p.reportsAgainst.total} time${p.reportsAgainst.total === 1 ? "" : "s"},
        ${p.reportsAgainst.actioned} upheld.</p>
      <h3>Moderation</h3>
      ${control}
      <h3 style="margin-top:1rem">Reports against them</h3>
      <div class="admin-rows">${reports}</div>
      <h3 style="margin-top:1rem">Ladders</h3>
      <div class="admin-rows">${ratings}</div>
      <h3 style="margin-top:1rem">Recent ranked games</h3>
      <div class="admin-rows">${matches}</div>
    </div>`;
  }

  // The button says exactly what it is about to do, which is worth more than a
  // confirm dialog people learn to click through.
  $("player-detail").addEventListener("change", (e) => {
    if (e.target.id !== "ban-days") return;
    const days = e.target.value;
    $("ban-go").textContent = days ? `Suspend for ${days} day${days === "1" ? "" : "s"}` : "Suspend permanently";
  });

  $("player-detail").addEventListener("click", async (e) => {
    const go = e.target.closest("#ban-go");
    const unban = e.target.closest("[data-unban]");
    if (unban) {
      unban.disabled = true;
      try {
        await api(`/api/admin/bans/${unban.dataset.unban}`, { method: "DELETE" });
        WG.toast("Suspension lifted.");
        openPlayer(unban.dataset.unban);
      } catch (err) {
        unban.disabled = false;
        WG.toast(err.message);
      }
      return;
    }
    if (!go) return;

    go.disabled = true;
    try {
      const days = $("ban-days").value;
      const { disconnected } = await api("/api/admin/bans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: Number(go.dataset.user),
          reason: $("ban-reason").value.trim(),
          days: days === "" ? null : Number(days),
        }),
      });
      WG.toast(disconnected ? `Suspended — dropped ${disconnected} live connection(s).` : "Suspended.");
      openPlayer(go.dataset.user);
    } catch (err) {
      go.disabled = false;
      WG.toast(err.message);
    }
  });

  showTab("overview");
})();
