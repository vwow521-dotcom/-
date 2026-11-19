// Persistent state in <project>/.bridge/bridge.db (node:sqlite, no native deps).
// The .bridge directory ignores itself in git so auto-commits never pick up the DB.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type RunStatus = "active" | "awaiting_approval" | "done" | "stopped";
export type AttemptStatus = "ready" | "in_progress" | "awaiting_approval" | "approved" | "rejected" | "done" | "cancelled";

export interface Run {
  id: number;
  goal: string;
  status: RunStatus;
  created_at: string;
  ended_at: string | null;
}

export interface Attempt {
  id: number;
  run_id: number;
  stage_id: string;
  agent: string;
  status: AttemptStatus;
  feedback: string | null; // human comment carried into this attempt (e.g. a rejection reason)
  handoff_id: number | null;
  assigned_at: string;
  started_at: string | null;
  ended_at: string | null;
  decided_note: string | null; // human comment at the gate
}

export interface HandoffData {
  summary: string;
  done: string[];
  todo: string[];
  decisions: { what: string; why: string }[];
  files_changed: string[];
  notes_for_next: string;
  verdict?: "approve" | "reject";
  review_comments?: string[]; // blocking issues that must be fixed
  observations?: string[]; // non-blocking suggestions
}

/** Structured rework/approval feedback carried into an attempt (stored as JSON in attempts.feedback). */
export interface Feedback {
  kind: "rework" | "approval_note" | "carried";
  from_stage: string;
  user_requirements: string[]; // what the human asked for at the gate — must be done
  blocking: string[]; // review issues behind a reject verdict — must be fixed
  observations: string[]; // non-blocking review notes — optional
}

export interface Handoff {
  id: number;
  run_id: number;
  attempt_id: number;
  stage_id: string;
  agent: string;
  data: HandoffData;
  commit_sha: string | null;
  commit_error: string | null;
  scope_notes: string[]; // e.g. files changed but not declared, files owned by another stage
  created_at: string;
}

export interface Note {
  id: number;
  run_id: number | null;
  agent: string;
  topic: string;
  text: string;
  created_at: string;
}

export interface Question {
  id: number;
  run_id: number | null;
  agent: string;
  question: string;
  answer: string | null;
  created_at: string;
  answered_at: string | null;
}

export type MailStatus = "queued" | "rung" | "fetched" | "acked" | "stuck" | "void";
export type MailKind = "task" | "answer" | "human" | "agent" | "system";

/** One row per recipient. The id is the dedupe key (INSERT OR IGNORE). */
export interface Mail {
  id: string;
  run_id: number | null;
  attempt_id: number | null; // task mail → the attempt it hands out
  from_agent: string; // agent id, "human" or "bridge"
  to_agent: string;
  kind: MailKind;
  subject: string;
  body: string;
  importance: "normal" | "high";
  ack_required: number; // 0/1
  status: MailStatus;
  ring_count: number;
  created_at: string;
  rung_at: string | null;
  fetched_at: string | null;
  acked_at: string | null;
  overdue_flagged: number; // 0/1, so the human is told only once
}

export interface BridgeEvent {
  id: number;
  run_id: number | null;
  agent: string | null;
  kind: string;
  text: string;
  created_at: string;
}

const now = () => new Date().toISOString();

export class Store {
  readonly db: DatabaseSync;

  constructor(projectDir: string) {
    const dir = path.join(projectDir, ".bridge");
    fs.mkdirSync(dir, { recursive: true });
    const gi = path.join(dir, ".gitignore");
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, "*\n");
    this.db = new DatabaseSync(path.join(dir, "bridge.db"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY, goal TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, ended_at TEXT);
      CREATE TABLE IF NOT EXISTS attempts (
        id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL, stage_id TEXT NOT NULL, agent TEXT NOT NULL,
        status TEXT NOT NULL, feedback TEXT, handoff_id INTEGER, decided_note TEXT,
        assigned_at TEXT NOT NULL, started_at TEXT, ended_at TEXT);
      CREATE TABLE IF NOT EXISTS handoffs (
        id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL, attempt_id INTEGER NOT NULL, stage_id TEXT NOT NULL,
        agent TEXT NOT NULL, data TEXT NOT NULL, commit_sha TEXT, commit_error TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY, run_id INTEGER, agent TEXT NOT NULL, topic TEXT NOT NULL,
        text TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS questions (
        id INTEGER PRIMARY KEY, run_id INTEGER, agent TEXT NOT NULL, question TEXT NOT NULL,
        answer TEXT, created_at TEXT NOT NULL, answered_at TEXT);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY, run_id INTEGER, agent TEXT, kind TEXT NOT NULL,
        text TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mail (
        id TEXT PRIMARY KEY, run_id INTEGER, attempt_id INTEGER, from_agent TEXT NOT NULL, to_agent TEXT NOT NULL,
        kind TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, importance TEXT NOT NULL,
        ack_required INTEGER NOT NULL, status TEXT NOT NULL, ring_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, rung_at TEXT, fetched_at TEXT, acked_at TEXT, overdue_flagged INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS mail_to_status ON mail (to_agent, status);
      CREATE TABLE IF NOT EXISTS codex_threads (
        session_id TEXT PRIMARY KEY, agent TEXT NOT NULL, registered_at TEXT NOT NULL, last_parked_at TEXT);
    `);
    // Migrations for databases created by earlier versions.
    const cols = (t: string) => (this.db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    if (!cols("handoffs").includes("scope_notes")) this.db.exec("ALTER TABLE handoffs ADD COLUMN scope_notes TEXT");
  }

  // ---- mail
  /** Returns false when a mail with this id already exists (dedupe). */
  addMail(m: Omit<Mail, "status" | "ring_count" | "created_at" | "rung_at" | "fetched_at" | "acked_at" | "overdue_flagged">): boolean {
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO mail (id, run_id, attempt_id, from_agent, to_agent, kind, subject, body, importance, ack_required, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
      )
      .run(m.id, m.run_id, m.attempt_id, m.from_agent, m.to_agent, m.kind, m.subject, m.body, m.importance, m.ack_required, now());
    return Number(r.changes) > 0;
  }
  mail(id: string) {
    return this.one<Mail>("SELECT * FROM mail WHERE id = ?", id);
  }
  mailByStatus(to: string, statuses: MailStatus[]) {
    return this.all<Mail>(
      `SELECT * FROM mail WHERE to_agent = ? AND status IN (${statuses.map(() => "?").join(",")}) ORDER BY created_at, id`,
      to,
      ...statuses,
    );
  }
  allMailByStatus(statuses: MailStatus[]) {
    return this.all<Mail>(`SELECT * FROM mail WHERE status IN (${statuses.map(() => "?").join(",")}) ORDER BY created_at`, ...statuses);
  }
  setMailStatus(ids: string[], status: MailStatus) {
    const col = { rung: "rung_at", fetched: "fetched_at", acked: "acked_at" }[status as string];
    for (const id of ids) {
      if (status === "rung") this.exec("UPDATE mail SET status = 'rung', rung_at = ?, ring_count = ring_count + 1 WHERE id = ?", now(), id);
      else if (col) this.exec(`UPDATE mail SET status = ?, ${col} = COALESCE(${col}, ?) WHERE id = ?`, status, now(), id);
      else this.exec("UPDATE mail SET status = ? WHERE id = ?", status, id);
    }
  }
  flagOverdue(id: string) {
    this.exec("UPDATE mail SET overdue_flagged = 1 WHERE id = ?", id);
  }
  taskMailFor(attempt_id: number) {
    return this.all<Mail>("SELECT * FROM mail WHERE attempt_id = ? AND kind = 'task' ORDER BY created_at", attempt_id);
  }
  recentMail(limit = 30) {
    return this.all<Mail>("SELECT * FROM mail ORDER BY created_at DESC, id DESC LIMIT ?", limit);
  }

  // ---- Codex threads that joined the bridge (session_id from the Stop hook ↔ agent id)
  registerCodexThread(session_id: string, agent: string) {
    this.exec(
      "INSERT INTO codex_threads (session_id, agent, registered_at, last_parked_at) VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET agent = excluded.agent, last_parked_at = excluded.last_parked_at",
      session_id, agent, now(), now(),
    );
  }
  codexThreads() {
    return this.all<{ session_id: string; agent: string; registered_at: string; last_parked_at: string | null }>(
      "SELECT * FROM codex_threads ORDER BY last_parked_at DESC",
    );
  }

  private all<T>(sql: string, ...args: (string | number | null)[]): T[] {
    return this.db.prepare(sql).all(...args) as unknown as T[];
  }
  private one<T>(sql: string, ...args: (string | number | null)[]): T | undefined {
    return this.db.prepare(sql).get(...args) as unknown as T | undefined;
  }
  private insert(sql: string, ...args: (string | number | null)[]): number {
    return Number(this.db.prepare(sql).run(...args).lastInsertRowid);
  }
  private exec(sql: string, ...args: (string | number | null)[]) {
    this.db.prepare(sql).run(...args);
  }

  // ---- runs
  createRun(goal: string): Run {
    const id = this.insert("INSERT INTO runs (goal, status, created_at) VALUES (?, 'active', ?)", goal, now());
    return this.run(id)!;
  }
  run(id: number) {
    return this.one<Run>("SELECT * FROM runs WHERE id = ?", id);
  }
  openRun() {
    return this.one<Run>("SELECT * FROM runs WHERE status IN ('active','awaiting_approval') ORDER BY id DESC LIMIT 1");
  }
  recentRuns(limit = 10) {
    return this.all<Run>("SELECT * FROM runs ORDER BY id DESC LIMIT ?", limit);
  }
  setRunStatus(id: number, status: RunStatus) {
    const ended = status === "done" || status === "stopped" ? now() : null;
    this.exec("UPDATE runs SET status = ?, ended_at = COALESCE(?, ended_at) WHERE id = ?", status, ended, id);
  }

  // ---- attempts (one row per time a stage is handed to an agent)
  createAttempt(run_id: number, stage_id: string, agent: string, feedback: string | null): Attempt {
    const id = this.insert(
      "INSERT INTO attempts (run_id, stage_id, agent, status, feedback, assigned_at) VALUES (?, ?, ?, 'ready', ?, ?)",
      run_id, stage_id, agent, feedback, now(),
    );
    return this.attempt(id)!;
  }
  attempt(id: number) {
    return this.one<Attempt>("SELECT * FROM attempts WHERE id = ?", id);
  }
  attempts(run_id: number) {
    return this.all<Attempt>("SELECT * FROM attempts WHERE run_id = ? ORDER BY id", run_id);
  }
  /** The run's live attempt: ready, in progress or waiting at a gate. */
  liveAttempt(run_id: number) {
    return this.one<Attempt>(
      "SELECT * FROM attempts WHERE run_id = ? AND status IN ('ready','in_progress','awaiting_approval') ORDER BY id DESC LIMIT 1",
      run_id,
    );
  }
  updateAttempt(id: number, fields: Partial<Pick<Attempt, "status" | "handoff_id" | "started_at" | "ended_at" | "decided_note">>) {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (!keys.length) return;
    this.exec(`UPDATE attempts SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...keys.map((k) => fields[k] ?? null), id);
  }

  // ---- handoffs
  addHandoff(h: Omit<Handoff, "id" | "created_at">): Handoff {
    const id = this.insert(
      "INSERT INTO handoffs (run_id, attempt_id, stage_id, agent, data, commit_sha, commit_error, scope_notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      h.run_id, h.attempt_id, h.stage_id, h.agent, JSON.stringify(h.data), h.commit_sha, h.commit_error, JSON.stringify(h.scope_notes), now(),
    );
    return this.handoff(id)!;
  }
  private parseHandoff(row: any): Handoff {
    return { ...row, data: JSON.parse(row.data), scope_notes: row.scope_notes ? JSON.parse(row.scope_notes) : [] };
  }
  handoff(id: number) {
    const r = this.one<any>("SELECT * FROM handoffs WHERE id = ?", id);
    return r && this.parseHandoff(r);
  }
  handoffs(run_id: number) {
    return this.all<any>("SELECT * FROM handoffs WHERE run_id = ? ORDER BY id", run_id).map((r) => this.parseHandoff(r));
  }

  // ---- notes (run_id null = project-wide)
  addNote(run_id: number | null, agent: string, topic: string, text: string) {
    return this.insert("INSERT INTO notes (run_id, agent, topic, text, created_at) VALUES (?, ?, ?, ?, ?)", run_id, agent, topic, text, now());
  }
  notes(topic?: string) {
    return topic
      ? this.all<Note>("SELECT * FROM notes WHERE topic = ? ORDER BY id", topic)
      : this.all<Note>("SELECT * FROM notes ORDER BY id");
  }

  // ---- questions to the human
  addQuestion(run_id: number | null, agent: string, question: string) {
    return this.insert("INSERT INTO questions (run_id, agent, question, created_at) VALUES (?, ?, ?, ?)", run_id, agent, question, now());
  }
  question(id: number) {
    return this.one<Question>("SELECT * FROM questions WHERE id = ?", id);
  }
  openQuestions() {
    return this.all<Question>("SELECT * FROM questions WHERE answer IS NULL ORDER BY id");
  }
  answerQuestion(id: number, answer: string) {
    this.exec("UPDATE questions SET answer = ?, answered_at = ? WHERE id = ? AND answer IS NULL", answer, now(), id);
  }

  // ---- event feed (progress reports + system events), shown on the panel
  addEvent(run_id: number | null, agent: string | null, kind: string, text: string) {
    this.insert("INSERT INTO events (run_id, agent, kind, text, created_at) VALUES (?, ?, ?, ?, ?)", run_id, agent, kind, text, now());
  }
  recentEvents(limit = 50) {
    return this.all<BridgeEvent>("SELECT * FROM events ORDER BY id DESC LIMIT ?", limit);
  }
}
