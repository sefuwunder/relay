// Relay attachment checks: db helpers, SMTP MIME building, and the HTTP
// attachment flow (multipart upload -> failed-message persistence -> files
// list -> download -> delete cleanup). Run with: bun tests/attachments-check.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
function ok(cond: unknown, label: string) {
  if (!cond) { console.error(`FAIL: ${label}`); process.exitCode = 1; return; }
  passed++;
}

// ---------- 1. db attachment helpers (temp sqlite) ----------
{
  const dir = mkdtempSync(join(tmpdir(), "relay-att-"));
  const db = await import("../src/db.ts");
  db.openDb(join(dir, "relay.db"));
  const c = db.createContact({ name: "File Friend", email: "friend@example.com", gv_number: "", matrix_id: "", matrix_room_id: "", color: "#0a84ff", notes: "" });
  const conv = db.dmFor(c.id);
  const m1 = db.insertMessage({ conversation_id: conv.id, channel: "email", direction: "out", body: "see attached", subject: "s", external_id: "", status: "sent" });
  const m2 = db.insertMessage({ conversation_id: conv.id, channel: "email", direction: "in", body: "got it", subject: "s", external_id: "x", status: "" });
  const a1 = db.insertAttachment({ message_id: m1.id, filename: "photo.png", mime: "image/png", size: 1234 });
  const a2 = db.insertAttachment({ message_id: m1.id, filename: "notes.txt", mime: "text/plain", size: 42 });
  const a3 = db.insertAttachment({ message_id: m2.id, filename: "clip.mp4", mime: "video/mp4", size: 999 });
  ok(a1.id && a1.message_id === m1.id, "insertAttachment returns a row linked to the message");
  const forMsgs = db.listAttachmentsForMessages([m1.id, m2.id, "nope"]);
  ok(forMsgs.length === 3, "listAttachmentsForMessages returns all rows in one query");
  ok(db.listAttachmentsForMessages([]).length === 0, "listAttachmentsForMessages handles empty input");
  const recent = db.listConversationAttachments(conv.id, 30);
  ok(recent.length === 3 && recent[0].id === a3.id, "listConversationAttachments is newest-first");
  ok(recent[0].direction === "in" && recent[0].filename === "clip.mp4", "listConversationAttachments carries direction + filename");
  ok(db.getAttachment(a2.id)?.mime === "text/plain", "getAttachment finds a row");
  ok(db.getAttachment("missing") === null, "getAttachment returns null when missing");
  const removed = db.deleteConversationData(conv.id);
  ok(removed.length === 3 && removed.includes(a1.id), "deleteConversationData returns removed attachment ids");
  ok(db.listConversationAttachments(conv.id, 30).length === 0, "deleteConversationData clears attachment rows");
  rmSync(dir, { recursive: true, force: true });
}

// ---------- 2. SMTP MIME with attachments ----------
{
  const smtp = await import("../src/smtp.ts");
  const cfg = { host: "smtp.example.com", port: 465, secure: "ssl" as const, user: "", pass: "", from: "me@example.com", fromName: "Me" };
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const msg = smtp.buildMessage(cfg, {
    to: ["you@example.com"], subject: "files", text: "see attached",
    attachments: [
      { filename: "photo.png", mime: "image/png", data: pngBytes },
      { filename: "evil\"\r\nname.txt", mime: "text/plain", data: Buffer.from("hello") },
    ],
  });
  ok(msg.includes("multipart/mixed"), "buildMessage uses multipart/mixed when attachments exist");
  ok(msg.includes('filename="photo.png"'), "buildMessage names the png part");
  ok(!msg.includes('evil"\r\nname'), "buildMessage strips header-breaking chars from filenames");
  ok(msg.includes("Content-Transfer-Encoding: base64"), "buildMessage base64-encodes parts");
  // Round-trip the png bytes out of the MIME body.
  const b64 = pngBytes.toString("base64");
  ok(msg.replace(/\r\n/g, "").includes(b64), "buildMessage carries the exact file bytes as base64");
  ok(msg.includes("see attached"), "buildMessage keeps the text part");
  const plain = smtp.buildMessage(cfg, { to: ["you@example.com"], subject: "hi", text: "hello" });
  ok(!plain.includes("multipart") && plain.includes("hello"), "buildMessage stays single-part without attachments");
}

// ---------- 3. HTTP flow against a live server in a temp cwd ----------
{
  const dir = mkdtempSync(join(tmpdir(), "relay-srv-"));
  const { execSync, spawn } = await import("node:child_process");
  execSync(`ln -s ${process.cwd()}/public ${dir}/public && ln -s ${process.cwd()}/src ${dir}/src`);
  const port = 4100 + Math.floor(Math.random() * 800);
  const srv = spawn("bun", ["src/server.ts"], { cwd: dir, env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  const wait = async () => {
    for (let i = 0; i < 100; i++) {
      try { const r = await fetch(base + "/api/conversations"); if (r.ok) return; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("server did not start");
  };
  try {
    await wait();
    // Contact with email only (no SMTP configured -> sends fail fast, which is
    // exactly the path that must still persist attachments for Retry).
    const cc = await (await fetch(base + "/api/contacts", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "File Friend", email: "friend@example.com" }),
    })).json();
    const convId = cc.contact && (await (await fetch(base + `/api/contacts/${cc.contact.id}`)).json()).contact.conversation_id;
    ok(!!convId, "contact creation exposes the DM conversation id");

    // Multipart upload: text + png + txt. SMTP is unconfigured so the send
    // fails and the message is recorded as failed — attachments must survive.
    const form = new FormData();
    form.set("channel", "email");
    form.set("body", "two files for you");
    form.set("subject", "files");
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    form.append("files", new File([pngBytes], "photo.png", { type: "image/png" }));
    form.append("files", new File(["hello world"], "notes.txt", { type: "text/plain" }));
    const post = await fetch(base + `/api/conversations/${convId}/messages`, { method: "POST", body: form });
    const pj = await post.json();
    ok(!post.ok && pj.failed_message, "failed send still records the message");
    const fm = pj.failed_message;
    ok(fm.attachments && fm.attachments.length === 2, "failed message carries both attachments");
    ok(fm.attachments[0].filename === "photo.png" && String(fm.attachments[1].mime).startsWith("text/plain"), "attachment metadata is intact");

    // Non-email channels must refuse attachments with a clear error.
    const form2 = new FormData();
    form2.set("channel", "sms");
    form2.set("body", "x");
    form2.append("files", new File(["x"], "a.txt", { type: "text/plain" }));
    const rej = await fetch(base + `/api/conversations/${convId}/messages`, { method: "POST", body: form2 });
    ok(rej.status === 400, "sms + attachments is rejected");

    // Files widget endpoint.
    const fj = await (await fetch(base + `/api/conversations/${convId}/files?limit=30`)).json();
    ok(fj.files && fj.files.length === 2, "files endpoint lists both attachments");
    ok(fj.files.every((f: any) => f.filename), "files endpoint returns filenames");

    // Download round-trip.
    const dl = await fetch(base + `/api/attachments/${fm.attachments[0].id}`);
    ok(dl.ok, "attachment download responds 200");
    ok(dl.headers.get("content-type") === "image/png", "download serves the stored mime");
    const got = new Uint8Array(await dl.arrayBuffer());
    ok(got.length === pngBytes.length && got.every((v, i) => v === pngBytes[i]), "downloaded bytes match the upload");

    // Unknown id -> 404.
    ok((await fetch(base + "/api/attachments/nope")).status === 404, "unknown attachment id is 404");

    // GET messages embeds attachments.
    const mj = await (await fetch(base + `/api/conversations/${convId}/messages?limit=100`)).json();
    const withAtt = mj.messages.find((m: any) => m.id === fm.id);
    ok(withAtt && withAtt.attachments.length === 2, "GET messages embeds attachments");

    // Delete the conversation -> rows and files are gone.
    const del = await fetch(base + `/api/conversations/${convId}`, { method: "DELETE" });
    ok(del.ok, "conversation delete succeeds");
    ok((await fetch(base + `/api/attachments/${fm.attachments[0].id}`)).status === 404, "attachment gone after conversation delete");
  } finally {
    srv.kill();
    await new Promise((r) => setTimeout(r, 300));
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- 4. attachment persistence failure degrades gracefully ----------
// Pre-create ./data/attachments as a regular FILE so every byte write fails
// (ENOTDIR, even for root). The failed-message path must still record the
// message and leave no orphan attachment rows behind.
{
  const dir = mkdtempSync(join(tmpdir(), "relay-attfail-"));
  const { execSync, spawn } = await import("node:child_process");
  const { writeFileSync, rmSync: rm } = await import("node:fs");
  execSync(`ln -s ${process.cwd()}/public ${dir}/public && ln -s ${process.cwd()}/src ${dir}/src && mkdir -p ${dir}/data`);
  writeFileSync(join(dir, "data", "attachments"), "not a directory");
  const port = 4100 + Math.floor(Math.random() * 800);
  const srv = spawn("bun", ["src/server.ts"], { cwd: dir, env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  const wait = async () => {
    for (let i = 0; i < 100; i++) {
      try { const r = await fetch(base + "/api/conversations"); if (r.ok) return; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("server did not start");
  };
  try {
    await wait();
    const cc = await (await fetch(base + "/api/contacts", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "File Friend", email: "friend@example.com" }),
    })).json();
    const convId = cc.contact && (await (await fetch(base + `/api/contacts/${cc.contact.id}`)).json()).contact.conversation_id;
    ok(!!convId, "disk-fail instance: contact creation works");

    const form = new FormData();
    form.set("channel", "email");
    form.set("body", "files with a broken disk");
    form.set("subject", "files");
    form.append("files", new File(["aaa"], "a.txt", { type: "text/plain" }));
    form.append("files", new File(["bbb"], "b.txt", { type: "text/plain" }));
    const post = await fetch(base + `/api/conversations/${convId}/messages`, { method: "POST", body: form });
    const pj = await post.json();
    ok(!post.ok && pj.failed_message, "disk-fail: failed send still records the message");
    ok(Array.isArray(pj.failed_message.attachments) && pj.failed_message.attachments.length === 0,
      "disk-fail: no phantom attachments on the failed message");
    const fj = await (await fetch(base + `/api/conversations/${convId}/files?limit=30`)).json();
    ok(fj.files && fj.files.length === 0, "disk-fail: no orphan attachment rows left behind");

    // Remove the blocker: the very next send persists attachments normally,
    // proving the instance recovered.
    rm(join(dir, "data", "attachments"), { force: true });
    const form2 = new FormData();
    form2.set("channel", "email");
    form2.set("body", "disk is back");
    form2.append("files", new File(["ccc"], "c.txt", { type: "text/plain" }));
    const post2 = await fetch(base + `/api/conversations/${convId}/messages`, { method: "POST", body: form2 });
    const pj2 = await post2.json();
    ok(!post2.ok && pj2.failed_message && pj2.failed_message.attachments.length === 1,
      "disk recovered: failed message carries its attachment again");
  } finally {
    srv.kill();
    await new Promise((r) => setTimeout(r, 300));
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`attachments checks: ${passed} passed${process.exitCode ? " (WITH FAILURES)" : ""}`);
