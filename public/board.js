// Command board. Plain JS, no build step. Owner token (if configured) is kept in this tab only.
const $ = (id) => document.getElementById(id);
const token = () => sessionStorage.getItem("jarvisToken") || "";
let conversationId;

async function api(path, body) {
  const res = await fetch(`/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(token() && { authorization: `Bearer ${token()}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    const t = prompt("Board token");
    if (t) { sessionStorage.setItem("jarvisToken", t); return api(path, body); }
  }
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const usd = (micro) => `$${(micro / 1e6).toFixed(2)}`;
const list = (el, items, render, empty) => { $(el).innerHTML = items.length ? items.map(render).join("") : `<p class="empty">${empty}</p>`; };
// Profile approvals and their audit entries carry a profile ID where stories carry a work item ID.
const ref = (id) => (/^\d+$/.test(String(id)) ? `AB#${esc(id)}` : esc(id));
const num = (v) => (v === null || v === undefined ? `<span title="unknown">—</span>` : Number.isInteger(v) ? v : v.toFixed(1));

/** Line diff (longest common subsequence) of the parent's instructions against the proposal's. */
function lineDiff(before, after) {
  const x = before ? before.split("\n") : [], y = after.split("\n");
  const L = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--)
    L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  for (let i = 0, j = 0; i < x.length || j < y.length;) {
    if (i < x.length && j < y.length && x[i] === y[j]) { out.push(`<span>  ${esc(x[i])}</span>`); i++; j++; }
    else if (i < x.length && (j >= y.length || L[i + 1][j] >= L[i][j + 1])) out.push(`<span class="del">- ${esc(x[i++])}</span>`);
    else out.push(`<span class="add">+ ${esc(y[j++])}</span>`);
  }
  return out.join("\n");
}

const profileBlock = (p) => !p ? "" : `
    <div class="meta">Generation ${p.generation} · ${esc(p.specialty)} · parent ${esc(p.parentId)}</div>
    <pre class="diff">${lineDiff(p.parentInstructions, p.instructions)}</pre>
    <div class="meta">Tips included (${p.tips.length})</div>
    ${p.tips.map((t) => `<div class="tip"><strong>${esc(t.title ?? t.id)}</strong> <span class="tag ${esc(t.status)}">${esc(t.status)}</span>${t.body ? `<br>${esc(t.body)}` : ""}</div>`).join("")}
    ${p.skills.length ? `<div class="meta">Skills: ${p.skills.map(esc).join(", ")}</div>` : ""}`;

function render(s) {
  $("status-dot").classList.toggle("stopped", s.stopped);
  $("stopped-banner").hidden = !s.stopped;
  $("stop").hidden = s.stopped;
  $("resume").hidden = !s.stopped;
  $("approvals-count").textContent = s.approvals.length || "";

  list("approvals", s.approvals, (a) => `
    <div class="card"><div class="row"><strong>${esc(a.kind)} · ${ref(a.story_id)}</strong><span class="meta">${new Date(a.created).toLocaleString()}</span></div>
    <p>${esc(a.summary)}</p>
    ${profileBlock(a.profile)}
    ${JSON.parse(a.links || "[]").map((l) => `<a href="${esc(l)}" target="_blank" rel="noopener">${esc(l)}</a>`).join("<br>")}
    <div class="btns"><button data-approve="${a.id}">Approve</button><button class="ghost" data-deny="${a.id}">${a.kind === "profile" ? "Reject" : "Deny"}</button></div></div>`,
    "Nothing waiting on you.");

  $("generations").innerHTML = `<table><thead><tr><th>Gen</th><th>Profiles</th><th>Instances</th><th>PRs</th><th>Merged</th><th>CI runs</th><th>CI fails</th><th>Fails/PR</th><th>Tips used</th><th>Posted</th><th>Verified</th><th>Min to green</th></tr></thead><tbody>
    ${s.generations.map((g) => `<tr><td>${g.generation}</td><td>${g.profiles.map((p) => `<span class="tag ${esc(p.status)}" title="${esc(p.specialty)}">${esc(p.profileId)}</span>`).join(" ")}</td>
      <td>${num(g.instances)}</td><td>${num(g.prsOpened)}</td><td>${num(g.merged)}</td><td>${num(g.ciRuns)}</td><td>${num(g.ciFailures)}</td><td>${num(g.failuresPerPr)}</td>
      <td>${num(g.tipsUsed)}</td><td>${num(g.tipsPosted)}</td><td>${num(g.tipsVerified)}</td><td>${num(g.medianMinutesToFirstGreen)}</td></tr>`).join("")}</tbody></table>`;

  list("stories", s.stories, (st) => `
    <div class="card"><div class="row"><strong>AB#${esc(st.id)} ${esc(st.title)}</strong><span class="tag ${esc(st.stage)}">${esc(st.stage)}</span></div>
    <div class="meta">Spent ${usd(st.spent.microUsd)} of ${usd(st.budget_cap)}${st.spent.unknownRuns ? ` · ${st.spent.unknownRuns} run(s) cost unknown` : ""}
    ${st.pr_url ? ` · <a href="${esc(st.pr_url)}" target="_blank" rel="noopener">PR</a>` : ""}</div>
    ${st.blocked_reason ? `<p><strong>Blocked:</strong> ${esc(st.blocked_reason)}<br><strong>Next:</strong> ${esc(st.next_action)}</p>` : ""}</div>`,
    "No stories yet. Tag one jarvis in Azure Boards, or use Run with Jarvis.");

  list("runs", s.runs, (r) => `<div class="card"><div class="row"><span>${esc(r.agent)} · AB#${esc(r.story_id)}</span><span class="tag">${esc(r.status)}${r.waiting_on ? ` · ${esc(r.waiting_on)}` : ""}</span></div><div class="meta">${esc(r.id)}</div></div>`, "No runs.");

  list("shortcuts", s.shortcuts, (p) => `
    <div class="card"><div class="row"><strong>${esc(p.title)}</strong><span class="tag ${esc(p.status)}">${esc(p.status)}</span></div>
    <p>${esc(p.body)}</p>
    <div class="meta">${esc(p.type)} · by ${esc(p.author)}${p.verified_by ? ` · verified by ${esc(p.verified_by)}` : ""} · @${esc(p.commit_sha.slice(0, 7))} · used ${p.uses}×</div>
    ${p.status !== "retired" ? `<div class="btns"><button class="ghost" data-retire="${p.id}">Retire</button></div>` : ""}</div>`,
    "No posts yet.");

  list("reuse", s.reuseCandidates, (c) => `<div class="card"><div class="row"><strong>${esc(c.operation)}</strong><span class="tag">${c.draftable ? "draftable" : "needs recipe"}</span></div><div class="meta">${c.successes} successes across ${c.distinctAgents} agents</div></div>`, "No repeated work detected yet.");

  list("audit", s.audit, (e) => `<div class="meta">${new Date(e.at).toLocaleTimeString()} · <strong>${esc(e.actor)}</strong> ${esc(e.action)}${e.story_id ? ` · ${ref(e.story_id)}` : ""}</div>`, "Empty.");
}

async function refresh() {
  try { render(await api("/state")); } catch (e) { console.error(e); }
}

document.addEventListener("click", async (ev) => {
  const t = ev.target.closest("button");
  if (!t) return;
  if (t.dataset.approve) await api(`/approvals/${t.dataset.approve}`, { decision: "approved" });
  else if (t.dataset.deny) await api(`/approvals/${t.dataset.deny}`, { decision: "denied", note: prompt("Reason (optional)") || undefined });
  else if (t.dataset.retire) await api(`/shortcuts/${t.dataset.retire}/retire`, { reason: "removed_by_owner" });
  else if (t.id === "stop") { if (confirm("STOP ALL: cancel every run, block every tool, cancel CI?")) await api("/stop", {}); }
  else if (t.id === "resume") await api("/resume", {});
  else return;
  refresh();
});

$("run-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const out = await api(`/stories/${encodeURIComponent($("run-id").value)}/run`, {});
  if (!out.started) alert(`Not started: ${out.reason}`);
  refresh();
});

$("chat-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const msg = $("chat-input").value.trim();
  if (!msg) return;
  $("chat-input").value = "";
  $("chat-log").insertAdjacentHTML("beforeend", `<p><strong>You:</strong> ${esc(msg)}</p>`);
  const out = await api("/chat", { message: msg, conversationId });
  conversationId = out.conversationId;
  $("chat-log").insertAdjacentHTML("beforeend", `<p><strong>Jarvis:</strong> ${esc(out.reply)}</p>`);
  $("chat-log").scrollTop = $("chat-log").scrollHeight;
});

refresh();
setInterval(refresh, 4000);
