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
  meeting_id: number | null; // set when the run's tasks came out of a meeting
  created_at: string;
  ended_at: string | null;
}

/** A stage as a task runs it: the config stage shape, with a concrete agent. */
export interface TaskStage {
  id: string;
  role: string;
  agent: string;
  gate: boolean;
  on_reject?: string;
  instructions?: string;
  owns?: string[];
}

export type TaskStatus = "pending" | "active" | "done" | "cancelled";

/** One node of a run's task DAG. A pipeline run has exactly one task (T1) whose stages are the config pipeline. */
export interface Task {
  id: number;
  run_id: number;
  key: string; // T1, T2… unique within the run
  title: string;
  description: string;
  owner: string;
  reviewer: string | null;
  depends_on: string[]; // task keys
  paths: string[]; // globs leased while the task is active
  stages: TaskStage[];
  status: TaskStatus;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

export interface Lease {
  id: number;
  run_id: number | null;
  task_id: number | null; // null = reserved by hand outside a task
  agent: string;
  glob: string;
  exclusive: number; // 0/1
  reason: string;
  created_at: string;
  expires_at: string | null; // null = held until its task ends
  released_at: string | null;
}

export type MeetingStatus = "collecting" | "review" | "awaiting_approval" | "done" | "cancelled";
export type MeetingTurnKind = "proposal" | "critique" | "final";

export interface Meeting {
  id: number;
  topic: string;
  participants: string[];
  facilitator: string; // writes the final plan
  status: MeetingStatus;
  round: number; // current round, from 1
  round_kind: MeetingTurnKind;
  round_note: string | null; // what the human said when opening this round
  run_id: number | null;
  doc_path: string | null;
  created_at: string;
  ended_at: string | null;
}

/** A task as written in a meeting's final plan (before it becomes a Task row). */
export interface PlannedTask {
  id: string;
  title: string;
  description: string;
  owner: string;
  reviewer?: string | null;
  depends_on: string[];
  paths: string[];
}

export interface MeetingTurn {
  id: number;
  meeting_id: number;
  round: number;
  kind: MeetingTurnKind;
  agent: string;
  content: string;
  tasks: PlannedTask[] | null;
  decisions: { what: string; why: string }[];
  created_at: string;
}

export interface Attempt {
  id: number;
  run_id: number;
  task_id: number;
  stage_id: string;
  agent: string;
  status: AttemptStatus;
  feedback: string | null; // structured Feedback as JSON
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
export type MailKind = "task" | "answer" | "human" | "agent" | "system" | "meeting";

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
type Arg = string | number | null;

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
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL, key TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
        owner TEXT NOT NULL, reviewer TEXT, depends_on TEXT NOT NULL, paths TEXT NOT NULL, stages TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT);
      CREATE TABLE IF NOT EXISTS leases (
        id INTEGER PRIMARY KEY, run_id INTEGER, task_id INTEGER, agent TEXT NOT NULL, glob TEXT NOT NULL,
        exclusive INTEGER NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT, released_at TEXT);
      CREATE TABLE IF NOT EXISTS meetings (
        id INTEGER PRIMARY KEY, topic TEXT NOT NULL, participants TEXT NOT NULL, facilitator TEXT NOT NULL,
        status TEXT NOT NULL, round INTEGER NOT NULL, round_kind TEXT NOT NULL, round_note TEXT,
        run_id INTEGER, doc_path TEXT, created_at TEXT NOT NULL, ended_at TEXT);
      CREATE TABLE IF NOT EXISTS meeting_turns (
        id INTEGER PRIMARY KEY, meeting_id INTEGER NOT NULL, round INTEGER NOT NULL, kind TEXT NOT NULL, agent TEXT NOT NULL,
        content TEXT NOT NULL, tasks TEXT, decisions TEXT, created_at TEXT NOT NULL);
    `);
    // Migrations for databases created by earlier versions.
    const cols = (t: string) => (this.db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    if (!cols("handoffs").includes("scope_notes")) this.db.exec("ALTER TABLE handoffs ADD COLUMN scope_notes TEXT");
    if (!cols("attempts").includes("task_id")) this.db.exec("ALTER TABLE attempts ADD COLUMN task_id INTEGER");
    if (!cols("runs").includes("meeting_id")) this.db.exec("ALTER TABLE runs ADD COLUMN meeting_id INTEGER");
  }

  /** Pre-M2c runs have no task rows: give each one task (T1) running `stages`, and point its attempts at it. */
  migrateLegacyRuns(stages: TaskStage[]) {
    for (const run of this.all<Run>("SELECT * FROM runs WHERE id NOT IN (SELECT run_id FROM tasks)")) {
      const st: TaskStatus = run.status === "done" ? "done" : run.status === "stopped" ? "cancelled" : "active";
      const t = this.createTask(run.id, { key: "T1", title: run.goal, description: "", owner: stages[0].agent, reviewer: null, depends_on: [], paths: [], stages }, st);
      this.exec("UPDATE attempts SET task_id = ? WHERE run_id = ? AND task_id IS NULL", t.id, run.id);
    }
  }

  private all<T>(sql: string, ...args: Arg[]): T[] {
    return this.db.prepare(sql).all(...args) as unknown as T[];
  }
  private one<T>(sql: string, ...args: Arg[]): T | undefined {
    return this.db.prepare(sql).get(...args) as unknown as T | undefined;
  }
  private insert(sql: string, ...args: Arg[]): number {
    return Number(this.db.prepare(sql).run(...args).lastInsertRowid);
  }
  private exec(sql: string, ...args: Arg[]) {
    this.db.prepare(sql).run(...args);
  }
  private update(table: string, id: number, fields: Record<string, unknown>) {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    this.exec(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...keys.map((k) => (fields[k] ?? null) as Arg), id);
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
  /** Mail whose id starts with `prefix` (meeting mail ids encode meeting, round and recipient). */
  mailWithPrefix(prefix: string) {
    return this.all<Mail>("SELECT * FROM mail WHERE substr(id, 1, ?) = ? ORDER BY created_at", prefix.length, prefix);
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

  // ---- runs
  createRun(goal: string, meeting_id: number | null = null): Run {
    const id = this.insert("INSERT INTO runs (goal, status, meeting_id, created_at) VALUES (?, 'active', ?, ?)", goal, meeting_id, now());
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

  // ---- tasks
  createTask(run_id: number, t: Omit<Task, "id" | "run_id" | "status" | "created_at" | "started_at" | "ended_at">, status: TaskStatus = "pending"): Task {
    const id = this.insert(
      "INSERT INTO tasks (run_id, key, title, description, owner, reviewer, depends_on, paths, stages, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      run_id, t.key, t.title, t.description, t.owner, t.reviewer, JSON.stringify(t.depends_on), JSON.stringify(t.paths), JSON.stringify(t.stages), status, now(),
    );
    return this.task(id)!;
  }
  private parseTask(r: any): Task {
    return { ...r, depends_on: JSON.parse(r.depends_on), paths: JSON.parse(r.paths), stages: JSON.parse(r.stages) };
  }
  task(id: number): Task | undefined {
    const r = this.one<any>("SELECT * FROM tasks WHERE id = ?", id);
    return r && this.parseTask(r);
  }
  tasks(run_id: number): Task[] {
    return this.all<any>("SELECT * FROM tasks WHERE run_id = ? ORDER BY id", run_id).map((r) => this.parseTask(r));
  }
  setTaskStatus(id: number, status: TaskStatus) {
    const col = status === "active" ? "started_at" : status === "done" || status === "cancelled" ? "ended_at" : null;
    if (col) this.exec(`UPDATE tasks SET status = ?, ${col} = COALESCE(${col}, ?) WHERE id = ?`, status, now(), id);
    else this.exec("UPDATE tasks SET status = ? WHERE id = ?", status, id);
  }

  // ---- attempts (one row per time a stage is handed to an agent)
  createAttempt(run_id: number, task_id: number, stage_id: string, agent: string, feedback: string | null): Attempt {
    const id = this.insert(
      "INSERT INTO attempts (run_id, task_id, stage_id, agent, status, feedback, assigned_at) VALUES (?, ?, ?, ?, 'ready', ?, ?)",
      run_id, task_id, stage_id, agent, feedback, now(),
    );
    return this.attempt(id)!;
  }
  attempt(id: number) {
    return this.one<Attempt>("SELECT * FROM attempts WHERE id = ?", id);
  }
  attempts(run_id: number) {
    return this.all<Attempt>("SELECT * FROM attempts WHERE run_id = ? ORDER BY id", run_id);
  }
  /** The run's most recent live attempt: ready, in progress or waiting at a gate. */
  liveAttempt(run_id: number) {
    return this.one<Attempt>(
      "SELECT * FROM attempts WHERE run_id = ? AND status IN ('ready','in_progress','awaiting_approval') ORDER BY id DESC LIMIT 1",
      run_id,
    );
  }
  /** All live attempts of a run (parallel tasks can have several). */
  liveAttempts(run_id: number) {
    return this.all<Attempt>("SELECT * FROM attempts WHERE run_id = ? AND status IN ('ready','in_progress','awaiting_approval') ORDER BY id", run_id);
  }
  /** The task's live attempt (a task runs one stage at a time). */
  taskLiveAttempt(task_id: number) {
    return this.one<Attempt>(
      "SELECT * FROM attempts WHERE task_id = ? AND status IN ('ready','in_progress','awaiting_approval') ORDER BY id DESC LIMIT 1",
      task_id,
    );
  }
  agentAttempts(run_id: number, agent: string, statuses: AttemptStatus[]) {
    return this.all<Attempt>(
      `SELECT * FROM attempts WHERE run_id = ? AND agent = ? AND status IN (${statuses.map(() => "?").join(",")}) ORDER BY id`,
      run_id, agent, ...statuses,
    );
  }
  updateAttempt(id: number, fields: Partial<Pick<Attempt, "status" | "handoff_id" | "started_at" | "ended_at" | "decided_note">>) {
    this.update("attempts", id, fields);
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
  handoffs(run_id: number): Handoff[] {
    return this.all<any>("SELECT * FROM handoffs WHERE run_id = ? ORDER BY id", run_id).map((r) => this.parseHandoff(r));
  }
  taskHandoffs(task_id: number): Handoff[] {
    return this.all<any>("SELECT h.* FROM handoffs h JOIN attempts a ON a.id = h.attempt_id WHERE a.task_id = ? ORDER BY h.id", task_id).map((r) =>
      this.parseHandoff(r),
    );
  }

  // ---- file leases
  addLease(l: Omit<Lease, "id" | "created_at" | "released_at">) {
    return this.insert(
      "INSERT INTO leases (run_id, task_id, agent, glob, exclusive, reason, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      l.run_id, l.task_id, l.agent, l.glob, l.exclusive, l.reason, now(), l.expires_at,
    );
  }
  /** Leases not yet released, expired ones included (the caller decides what expiry means). */
  openLeases() {
    return this.all<Lease>("SELECT * FROM leases WHERE released_at IS NULL ORDER BY id");
  }
  releaseLeasesOfTask(task_id: number) {
    this.exec("UPDATE leases SET released_at = ? WHERE task_id = ? AND released_at IS NULL", now(), task_id);
  }
  releaseLeasesOfRun(run_id: number) {
    this.exec("UPDATE leases SET released_at = ? WHERE run_id = ? AND released_at IS NULL", now(), run_id);
  }
  releaseLease(id: number) {
    this.exec("UPDATE leases SET released_at = ? WHERE id = ? AND released_at IS NULL", now(), id);
  }
  setLeaseExpiry(id: number, expires_at: string | null) {
    this.exec("UPDATE leases SET expires_at = ? WHERE id = ?", expires_at, id);
  }

  // ---- meetings
  createMeeting(topic: string, participants: string[], facilitator: string): Meeting {
    const id = this.insert(
      "INSERT INTO meetings (topic, participants, facilitator, status, round, round_kind, created_at) VALUES (?, ?, ?, 'collecting', 1, 'proposal', ?)",
      topic, JSON.stringify(participants), facilitator, now(),
    );
    return this.meeting(id)!;
  }
  private parseMeeting(r: any): Meeting {
    return { ...r, participants: JSON.parse(r.participants) };
  }
  meeting(id: number): Meeting | undefined {
    const r = this.one<any>("SELECT * FROM meetings WHERE id = ?", id);
    return r && this.parseMeeting(r);
  }
  openMeeting(): Meeting | undefined {
    const r = this.one<any>("SELECT * FROM meetings WHERE status IN ('collecting','review','awaiting_approval') ORDER BY id DESC LIMIT 1");
    return r && this.parseMeeting(r);
  }
  recentMeetings(limit = 5): Meeting[] {
    return this.all<any>("SELECT * FROM meetings ORDER BY id DESC LIMIT ?", limit).map((r) => this.parseMeeting(r));
  }
  updateMeeting(id: number, f: Partial<Pick<Meeting, "status" | "round" | "round_kind" | "round_note" | "run_id" | "doc_path">>) {
    this.update("meetings", id, f);
    if (f.status === "done" || f.status === "cancelled") this.exec("UPDATE meetings SET ended_at = COALESCE(ended_at, ?) WHERE id = ?", now(), id);
  }
  addMeetingTurn(t: Omit<MeetingTurn, "id" | "created_at">) {
    return this.insert(
      "INSERT INTO meeting_turns (meeting_id, round, kind, agent, content, tasks, decisions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      t.meeting_id, t.round, t.kind, t.agent, t.content, t.tasks ? JSON.stringify(t.tasks) : null, JSON.stringify(t.decisions), now(),
    );
  }
  meetingTurns(meeting_id: number): MeetingTurn[] {
    return this.all<any>("SELECT * FROM meeting_turns WHERE meeting_id = ? ORDER BY round, id", meeting_id).map(
      (r): MeetingTurn => ({ ...r, tasks: r.tasks ? JSON.parse(r.tasks) : null, decisions: r.decisions ? JSON.parse(r.decisions) : [] }),
    );
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
