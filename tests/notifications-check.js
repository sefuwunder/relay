// Notification engine checks: dedupe, seeding, permission gating,
// open-conversation suppression, title badge, settings toggle.
const fs = require("fs");
const path = require("path");
const pub = path.join(__dirname, "..", "public");

function stubEl(id) {
  const el = {
    id: id || "", innerHTML: "", textContent: "", value: "", className: "", style: {},
    checked: false, dataset: {}, files: [], scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    _l: {},
    addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn); },
    removeEventListener() {},
    appendChild() {}, removeChild() {},
    querySelector(s) { return stubEl(s); },
    querySelectorAll() { return []; },
    focus() {}, click() {}, remove() {}, setAttribute() {},
    fire(t, e) { (this._l[t] || []).forEach((fn) => fn(e || {})); },
  };
  return el;
}
const store = {};
const selCache = {};
const ls = new Map();
const document = {
  title: "",
  visibilityState: "hidden",
  getElementById(id) { if (!store[id]) store[id] = stubEl(id); return store[id]; },
  querySelector(sel) {
    if (sel === "#app") return document.getElementById("app");
    if (!selCache[sel]) selCache[sel] = stubEl(sel);
    return selCache[sel];
  },
  querySelectorAll() { return []; },
  createElement() { return stubEl("created"); },
  body: { appendChild() {}, removeChild() {}, addEventListener() {} },
  addEventListener() {},
};
global.document = document;
global.window = { addEventListener() {}, focus() {}, location: { hash: "" } };
global.location = { hash: "" };
global.localStorage = {
  getItem: (k) => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => ls.set(k, String(v)),
  removeItem: (k) => ls.delete(k),
};
const notifications = [];
global.Notification = class {
  constructor(title, opts) { this.title = title; this.opts = opts || {}; notifications.push(this); }
  close() {}
  static requestPermission() { global.Notification.requested = true; return Promise.resolve("granted"); }
};
global.Notification.permission = "granted";
function syncNotif() { global.window.Notification = global.Notification; }
syncNotif();
global.fetch = async () => ({ ok: true, json: async () => ({}) });
global.setInterval = () => 0; global.clearInterval = () => {};
global.setTimeout = (fn) => { try { fn(); } catch {} return 0; };
global.alert = () => {}; global.confirm = () => false; global.prompt = () => null;

function load(f, extra) {
  let code = fs.readFileSync(path.join(pub, f), "utf8").replace('"use strict";', "");
  if (extra) code += extra;
  (0, eval)(code + `\n//# sourceURL=${f}`);
}
load("icons.js", "\n;globalThis.__ICONS__ = ICONS;");
load("app.js", "\n;globalThis.__APP__ = { state, pollConversations, checkNotifications, updateTitle, setNotify, notifyPerm, notifyHint, renderSettings, loadConversations, fireNotification, notificationIcon, playAlertSound, setSound };");
const A = globalThis.__APP__;
const { state } = A;

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; } else { fail++; console.log("FAIL:", name); } }
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
function conv(id, at, dir, body, unread) {
  return { id, title: "Name " + id, is_group: false, members: [], channels: ["sms"], last_body: body, last_at: at, last_channel: "sms", last_direction: dir, unread: unread || 0 };
}
function reset() {
  notifications.length = 0; ls.clear();
  state.conversations = []; state.conv = null; state.messages = [];
  state.notify = true; global.Notification.permission = "granted";
  document.visibilityState = "hidden"; document.title = "";
  for (const k of Object.keys(selCache)) delete selCache[k];
}

// 1. first poll seeds markers, fires nothing
reset();
state.conversations = [conv("c1", iso(3600000), "in", "hello", 1)];
A.checkNotifications(new Map());
ok("first sight seeds silently", notifications.length === 0 && ls.get("relay_seen_c1") === state.conversations[0].last_at);

// 2. new inbound message on tracked conv notifies
const at2 = iso(5000);
state.conversations = [conv("c1", at2, "in", "are you there?", 2)];
A.checkNotifications(new Map([["c1", iso(60000)]]));
ok("new inbound notifies", notifications.length === 1);
ok("notification title is conversation title", notifications[0].title === "Name c1");
ok("notification body has message text", notifications[0].opts.body.includes("are you there?"));
ok("notification tagged per conversation", notifications[0].opts.tag === "relay-c1");
ok("marker advances", ls.get("relay_seen_c1") === at2);

// 3. unchanged -> no second notification
A.checkNotifications(new Map([["c1", at2]]));
ok("no duplicate notification", notifications.length === 1);

// 4. outbound change -> silent
state.conversations = [conv("c1", iso(4000), "out", "my reply", 0)];
A.checkNotifications(new Map([["c1", at2]]));
ok("outbound change is silent", notifications.length === 1);

// 5a. notify off -> silent but marker advances
reset();
state.notify = false;
state.conversations = [conv("c1", iso(60000), "in", "hello", 1)];
A.checkNotifications(new Map());
state.conversations = [conv("c1", iso(5000), "in", "again", 2)];
A.checkNotifications(new Map([["c1", iso(60000)]]));
ok("toggle off silences", notifications.length === 0);
ok("marker still advances when off", typeof ls.get("relay_seen_c1") === "string");

// 5b. permission denied -> silent
reset();
global.Notification.permission = "denied";
state.conversations = [conv("c1", iso(60000), "in", "hello", 1)];
A.checkNotifications(new Map());
state.conversations = [conv("c1", iso(5000), "in", "again", 2)];
A.checkNotifications(new Map([["c1", iso(60000)]]));
ok("denied permission silences", notifications.length === 0);

// 6. open + visible conversation suppressed; other conv notifies
reset();
document.visibilityState = "visible";
state.conv = { id: "c1" };
state.conversations = [conv("c1", iso(3600000), "in", "seed", 1), conv("c2", iso(3600000), "in", "seed", 1)];
A.checkNotifications(new Map());
state.conversations = [conv("c1", iso(5000), "in", "ping c1", 2), conv("c2", iso(5000), "in", "ping c2", 2)];
A.checkNotifications(new Map([["c1", "old"], ["c2", "old"]]));
ok("open+visible conversation suppressed", notifications.length === 1 && notifications[0].opts.tag === "relay-c2");

// 7. hidden tab + open conversation -> notifies
reset();
document.visibilityState = "hidden";
state.conv = { id: "c1" };
state.conversations = [conv("c1", iso(3600000), "in", "seed", 1)];
A.checkNotifications(new Map());
state.conversations = [conv("c1", iso(5000), "in", "ping", 2)];
A.checkNotifications(new Map([["c1", "old"]]));
ok("hidden tab notifies even for open conversation", notifications.length === 1);

// 8. brand-new conversation with fresh inbound message notifies
reset();
state.conversations = [conv("c9", iso(30000), "in", "hi, new here", 1)];
A.checkNotifications(new Map());
ok("fresh new conversation notifies", notifications.length === 1);

// 9. old unseen conversation seeds silently (no history blast)
reset();
state.conversations = [conv("c9", iso(3600000), "in", "old unread", 1)];
A.checkNotifications(new Map());
ok("stale history seeds silently", notifications.length === 0 && ls.get("relay_seen_c9") !== null);

// 10. title badge
reset();
state.conversations = [conv("c1", iso(60000), "in", "a", 2), conv("c2", iso(60000), "out", "b", 0), conv("c3", iso(60000), "in", "c", 1)];
A.updateTitle();
ok("title shows unread count", document.title === "(3) Relay");
state.conversations.forEach((c) => (c.unread = 0));
A.updateTitle();
ok("title clears when read", document.title === "Relay");

// 11. permission helper
delete global.Notification; delete global.window.Notification;
ok("notifyPerm unsupported without API", A.notifyPerm() === "unsupported");
global.Notification = class { constructor(t, o) { this.title = t; this.opts = o; notifications.push(this); } close() {} static requestPermission() { return Promise.resolve("granted"); } };
syncNotif();
global.Notification.permission = "denied";
ok("notifyPerm reflects denied", A.notifyPerm() === "denied");

// 12. hint copy per state
global.Notification.permission = "granted"; state.notify = true;
ok("hint on", /On/.test(A.notifyHint()));
state.notify = false;
ok("hint off", /Off/.test(A.notifyHint()));
global.Notification.permission = "denied";
ok("hint denied", /Blocked/.test(A.notifyHint()));
delete global.Notification; delete global.window.Notification;
ok("hint unsupported", /doesn't support/.test(A.notifyHint()));
global.Notification = class { constructor(t, o) { this.title = t; this.opts = o; notifications.push(this); } close() {} static requestPermission() { global.Notification.requested = true; return Promise.resolve("granted"); } };
syncNotif();
global.Notification.permission = "default";

// 13. settings toggle wiring
async function flush() { await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); }
async function main() {
reset();
global.Notification.permission = "default";
state.status = {};
state.settings = { accounts: [], smtp: {}, imap: {}, matrix: {}, gv: {}, google: {} };
state.notify = false;
A.renderSettings();
const tgl = document.querySelector("#notify-toggle");
ok("toggle rendered off", tgl && tgl.checked === false);
ok("settings shows notifications section", document.getElementById("app").innerHTML.includes("New message notifications"));
tgl.checked = true;
tgl.fire("change", { target: tgl });
await flush();
ok("toggle persists on", ls.get("relay_notify") === "1" && state.notify === true);
ok("toggle requests permission", global.Notification.requested === true);
const tgl2 = document.querySelector("#notify-toggle");
tgl2.checked = false;
tgl2.fire("change", { target: tgl2 });
await flush();
ok("toggle persists off", ls.get("relay_notify") === "0" && state.notify === false);

// 14. notification click opens the conversation
reset();
state.conversations = [conv("c1", iso(60000), "in", "seed", 1)];
A.checkNotifications(new Map());
state.conversations = [conv("c1", iso(5000), "in", "yo", 2)];
A.checkNotifications(new Map([["c1", iso(60000)]]));
ok("click handler exists", typeof notifications[0].onclick === "function");
notifications[0].onclick();
ok("click navigates to conversation", location.hash === "#/conversations/c1");

// 15. empty body fallback
reset();
state.conversations = [conv("c1", iso(3600000), "in", "seed", 1)];
A.checkNotifications(new Map());
state.conversations = [conv("c1", iso(5000), "in", "", 2)];
A.checkNotifications(new Map([["c1", "old"]]));
ok("empty body falls back", notifications[0].opts.body === "New message");

// 16. notification icon: contact photo vs generated tile
ok("DM with photo uses the photo", A.notificationIcon({ is_group: false, title: "Alma", avatar_color: "#0a84ff", members: [{ avatar_url: "https://gravatar.com/avatar/abc" }] }) === "https://gravatar.com/avatar/abc");
const tile = A.notificationIcon({ is_group: false, title: "Alma", avatar_color: "#0a84ff", members: [{ avatar_url: null }] });
ok("DM without photo gets an initials tile", tile.startsWith("data:image/svg+xml,") && decodeURIComponent(tile).includes(">A<"));
const gtile = A.notificationIcon({ is_group: true, title: "Book Club", avatar_color: "#8e8e93", members: [{ avatar_url: "https://x/y.png" }] });
ok("group always gets a tile", gtile.startsWith("data:image/svg+xml,") && decodeURIComponent(gtile).includes(">BC<"));
const bad = A.notificationIcon({ is_group: true, title: "X", avatar_color: "red", members: [] });
ok("bad color falls back safely", decodeURIComponent(bad).includes("#8e8e93"));

// 17. fired notification carries the icon
reset();
const withPhoto = conv("c1", iso(3600000), "in", "seed", 1);
withPhoto.members = [{ id: "a", name: "Alma", color: "#0a84ff", avatar_url: "https://gravatar.com/avatar/abc" }];
state.conversations = [withPhoto];
A.checkNotifications(new Map());
state.conversations = [Object.assign({}, withPhoto, { last_at: iso(5000), last_body: "yo", unread: 2 })];
A.checkNotifications(new Map([["c1", "old"]]));
ok("notification carries the contact image", notifications[0].opts.icon === "https://gravatar.com/avatar/abc");

// 18. alert sound: plays with notification when on, silent when off
const audioCalls = [];
class FakeGain { constructor() { this.gain = { setValueAtTime() {}, exponentialRampToValueAtTime() {} }; } connect() { return this; } }
class FakeOsc { constructor() { this.type = ""; this.frequency = { value: 0 }; } connect() { return this; } start() { audioCalls.push("start"); } stop() {} }
global.window.AudioContext = class {
  constructor() { this.state = "running"; this.currentTime = 0; this.destination = {}; }
  createOscillator() { return new FakeOsc(); }
  createGain() { return new FakeGain(); }
  resume() { return Promise.resolve(); }
};
reset();
state.sound = true;
state.conversations = [conv("c1", iso(3600000), "in", "seed", 1)];
A.checkNotifications(new Map());
state.conversations = [conv("c1", iso(5000), "in", "yo", 2)];
A.checkNotifications(new Map([["c1", "old"]]));
ok("notification plays the chime when sound is on", audioCalls.filter((x) => x === "start").length === 2);
reset();
state.sound = false;
audioCalls.length = 0;
state.conversations = [conv("c1", iso(3600000), "in", "seed", 1)];
A.checkNotifications(new Map());
state.conversations = [conv("c1", iso(5000), "in", "yo", 2)];
A.checkNotifications(new Map([["c1", "old"]]));
ok("no sound when toggled off", audioCalls.length === 0);
ok("notification still fires when sound is off", notifications.length === 1);

// 19. sound toggle persists
reset();
state.status = {};
state.settings = { accounts: [], smtp: {}, imap: {}, matrix: {}, gv: {}, google: {} };
state.sound = true;
await A.setSound(false);
ok("setSound persists off", ls.get("relay_sound") === "0" && state.sound === false);
await A.setSound(true);
ok("setSound persists on", ls.get("relay_sound") === "1" && state.sound === true);

console.log(`\n${pass} passed, ${fail} failed`);
}
main().then(() => process.exit(fail ? 1 : 0));
