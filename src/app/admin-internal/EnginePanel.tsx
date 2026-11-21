"use client";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { compileAll, matchRule, ruleProblem, type ContentRule, type MatchType, type RuleType } from "@/lib/suggest/rules-core";
import { act, view } from "./AdminPower";

/**
 * Content engine (migration 0014): what players report, the rules the AI must follow, how strict each
 * Spin the Bottle mood is, and what players like or skip. The app makes content on its own; this is
 * where the admin steers it.
 */

const box = "rounded border-2 border-[#1e1a17] bg-white p-3";
const input = "rounded border-2 border-[#1e1a17] bg-white px-2 py-1 text-sm";
const button = "rounded border-2 border-[#1e1a17] px-3 py-1 text-sm font-bold disabled:opacity-40";
const danger = "rounded border-2 border-[#c23a22] bg-[#c23a22] px-3 py-1 text-sm font-bold text-white disabled:opacity-40";
const NOT_READY = "Could not load. Has migration 0014 been run in Supabase?";

const KIND_LABEL: Record<string, string> = {
  all: "Everything",
  "bottle-prompts": "Spin the Bottle",
  "emoji-puzzle": "Emoji Picture",
  "chor-kaun-topic": "Chor Kaun",
  "kbc-question": "KBC news",
  dare: "Dares",
};
const pct = (x: number) => `${Math.round(x * 100)}%`;

function Msg({ text, bad }: { text: string | null; bad?: boolean }) {
  if (!text) return null;
  return <p role="status" className={`text-sm font-bold ${bad ? "text-[#c23a22]" : "text-[#2f7d4f]"}`}>{text}</p>;
}

export function EnginePanel() {
  const [prefill, setPrefill] = useState<{ pattern: string; scope: string } | null>(null);
  return (
    <div className="mt-6 space-y-8">
      <p className="text-sm">
        The app makes and picks content on its own. Here you steer it: deal with what players report, add rules the AI must follow, choose how strict each mood is, and see what players like or skip.
      </p>
      <ReportsSection onBanSimilar={(pattern, scope) => setPrefill({ pattern, scope })} />
      <RulesSection prefill={prefill} />
      <StrictnessSection />
      <SignalsSection />
    </div>
  );
}

/* ---------------- Reports ---------------- */

interface ReportItem {
  kind: string;
  category: string;
  text_norm: string;
  text_key: string;
  shown: number;
  reported: number;
  inLibrary: boolean;
  active: boolean | null;
  offReason: string | null;
}

function ReportsSection({ onBanSimilar }: { onBanSimilar: (pattern: string, scope: string) => void }) {
  const [d, setD] = useState<{ threshold: number; items: ReportItem[] } | null>(null);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const load = () => view<{ threshold: number; items: ReportItem[] }>("reports").then(setD).catch(() => setMsg({ text: NOT_READY, bad: true }));
  useEffect(() => {
    load();
  }, []);
  const resolve = async (r: ReportItem, decision: "restore" | "remove") => {
    const res = await act("report.resolve", { kind: r.kind, category: r.category, norm: r.text_norm, decision });
    setMsg(res.ok ? { text: decision === "restore" ? "Put back and reports cleared." : "Kept off and reports cleared." } : { text: `Not changed: ${res.error}`, bad: true });
    load();
  };
  return (
    <section className="space-y-2">
      <h2 className="font-extrabold">Reports from players</h2>
      <p className="text-sm">
        When players tap &quot;report&quot; on a card, it shows up here. After {d?.threshold ?? 3} different rooms report the same item, it is switched off automatically. You decide whether it comes back.
      </p>
      {msg && <Msg text={msg.text} bad={msg.bad} />}
      {d && !d.items.length && <p className={box}>Nothing reported. 🎉</p>}
      {!!d?.items.length && (
        <ul className="space-y-2">
          {d.items.map((r) => (
            <li key={`${r.kind}|${r.category}|${r.text_norm}`} className={`${box} space-y-2 text-sm`}>
              <div className="font-bold">{r.text_key}</div>
              <div className="text-xs">
                {KIND_LABEL[r.kind] ?? r.kind} · {r.category} · reported by {r.reported} room{r.reported === 1 ? "" : "s"} · shown {r.shown}× ·{" "}
                {!r.inLibrary ? "built-in (edit it in the code)" : r.active ? "still being served" : r.offReason === "reports" ? "switched off automatically" : "switched off"}
              </div>
              <div className="flex flex-wrap gap-2">
                {r.inLibrary && <button className={button} onClick={() => resolve(r, "restore")}>It&apos;s fine · put back</button>}
                <button className={danger} onClick={() => resolve(r, "remove")}>{r.inLibrary ? "Remove for good" : "Clear reports"}</button>
                <button className={button} onClick={() => onBanSimilar(r.text_key.slice(0, 60), r.kind)}>Ban similar…</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ---------------- Rules ---------------- */

type RuleRow = ContentRule & { created_by?: string | null; created_at?: string };

const TYPE_HELP: Record<RuleType, string> = {
  block: "Block: drop anything containing this",
  topic: "Topic ban: the AI avoids this topic (and it's blocked too)",
  allow: "Allow: an exception to block rules",
};

function RulesSection({ prefill }: { prefill: { pattern: string; scope: string } | null }) {
  const [d, setD] = useState<{ rules: RuleRow[]; scopes: string[] } | null>(null);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [form, setForm] = useState({ rule_type: "block" as RuleType, match_type: "word" as MatchType, pattern: "", scope: "all", note: "" });
  const [test, setTest] = useState({ text: "", kind: "bottle-prompts" });
  const load = () => view<{ rules: RuleRow[]; scopes: string[] }>("rules").then(setD).catch(() => setMsg({ text: NOT_READY, bad: true }));
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    if (prefill) setForm((f) => ({ ...f, rule_type: "block", match_type: "word", pattern: prefill.pattern, scope: prefill.scope }));
  }, [prefill]);

  const problem = form.pattern.trim() ? ruleProblem(form) : null;
  const add = async (e: FormEvent) => {
    e.preventDefault();
    const r = await act("rule.add", { ...form });
    setMsg(r.ok ? { text: "Rule added. It applies within a minute." } : { text: `Not added: ${r.error}`, bad: true });
    if (r.ok) setForm((f) => ({ ...f, pattern: "", note: "" }));
    load();
  };
  const toggle = async (r: RuleRow) => {
    const res = await act("rule.set_active", { id: r.id, active: !r.active });
    setMsg(res.ok ? { text: `Rule ${r.active ? "paused" : "back on"}.` } : { text: `Not changed: ${res.error}`, bad: true });
    load();
  };
  const remove = async (r: RuleRow) => {
    if (!window.confirm(`Delete the rule "${r.pattern}"?`)) return;
    const res = await act("rule.delete", { id: r.id });
    setMsg(res.ok ? { text: "Rule deleted." } : { text: `Not deleted: ${res.error}`, bad: true });
    load();
  };

  const testResult = useMemo(() => {
    if (!test.text.trim() || !d) return null;
    const hit = matchRule(test.text, compileAll(d.rules, test.kind));
    return hit ? `Blocked by: ${TYPE_HELP[hit.rule_type].split(":")[0]} "${hit.pattern}"` : "Passes your rules. (The built-in safety rules still apply on top.)";
  }, [test, d]);

  return (
    <section className="space-y-2">
      <h2 className="font-extrabold">Rules for the AI</h2>
      <p className="text-sm">
        Rules apply to everything the AI makes and everything served from the library, including items saved before the rule existed. They work on top of the built-in safety rules, which can&apos;t be switched off.
      </p>
      {msg && <Msg text={msg.text} bad={msg.bad} />}
      <form onSubmit={add} className={`${box} flex flex-wrap items-end gap-2 text-sm`}>
        <label className="flex flex-col">
          Kind
          <select className={input} value={form.rule_type} onChange={(e) => setForm({ ...form, rule_type: e.target.value as RuleType })}>
            <option value="block">Block</option>
            <option value="topic">Topic ban</option>
            <option value="allow">Allow (exception)</option>
          </select>
        </label>
        <label className="flex flex-col">
          Match
          <select className={input} value={form.match_type} onChange={(e) => setForm({ ...form, match_type: e.target.value as MatchType })}>
            <option value="word">Whole word or phrase</option>
            <option value="pattern">Pattern (advanced)</option>
          </select>
        </label>
        <label className="flex min-w-[12rem] flex-1 flex-col">
          Word, phrase or topic
          <input className={input} value={form.pattern} maxLength={200} onChange={(e) => setForm({ ...form, pattern: e.target.value })} placeholder="e.g. a celebrity in the news" />
        </label>
        <label className="flex flex-col">
          Applies to
          <select className={input} value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value })}>
            {(d?.scopes ?? ["all"]).map((s) => (
              <option key={s} value={s}>{KIND_LABEL[s] ?? s}</option>
            ))}
          </select>
        </label>
        <label className="flex min-w-[10rem] flex-col">
          Note (why)
          <input className={input} value={form.note} maxLength={200} onChange={(e) => setForm({ ...form, note: e.target.value })} />
        </label>
        <button className={button} disabled={!form.pattern.trim() || !!problem}>Add rule</button>
        <p className="w-full text-xs">{problem ? `Can't save: ${problem.replace(/_/g, " ")}` : TYPE_HELP[form.rule_type]}</p>
      </form>

      <div className={`${box} space-y-2 text-sm`}>
        <div className="font-bold">Test a sentence</div>
        <div className="flex flex-wrap gap-2">
          <input className={`${input} min-w-[14rem] flex-1`} value={test.text} onChange={(e) => setTest({ ...test, text: e.target.value })} placeholder="Type a prompt to check it against your rules" />
          <select className={input} value={test.kind} onChange={(e) => setTest({ ...test, kind: e.target.value })}>
            {(d?.scopes ?? []).filter((s) => s !== "all").map((s) => (
              <option key={s} value={s}>{KIND_LABEL[s] ?? s}</option>
            ))}
          </select>
        </div>
        {testResult && <p className="font-bold">{testResult}</p>}
      </div>

      {d && !d.rules.length && <p className="text-sm">No rules yet.</p>}
      {!!d?.rules.length && (
        <table className="w-full text-left text-sm">
          <thead>
            <tr><th>Rule</th><th>Kind</th><th>Applies to</th><th>Note</th><th /></tr>
          </thead>
          <tbody>
            {d.rules.map((r) => (
              <tr key={r.id} className={`border-t border-[#1e1a17]/20 ${r.active ? "" : "opacity-50"}`}>
                <td className="font-mono">{r.pattern}{r.match_type === "pattern" ? " (pattern)" : ""}</td>
                <td>{r.rule_type === "topic" ? "topic ban" : r.rule_type}</td>
                <td>{KIND_LABEL[r.scope] ?? r.scope}</td>
                <td className="text-xs">{r.note}</td>
                <td className="whitespace-nowrap">
                  <button className={button} onClick={() => toggle(r)}>{r.active ? "Pause" : "Turn on"}</button>{" "}
                  <button className={danger} onClick={() => remove(r)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/* ---------------- Strictness ---------------- */

interface PolicyData {
  value: Record<string, Record<string, boolean>>;
  moods: string[];
  categories: { id: string; label: string; hint: string }[];
  allows: Record<string, string[]>;
}
const MOOD_LABEL: Record<string, string> = { kids: "🧒 Bacche", family: "👨‍👩‍👧 Parivaar", college: "🎓 College Gang", office: "💼 Office Party" };

function StrictnessSection() {
  const [d, setD] = useState<PolicyData | null>(null);
  const [value, setValue] = useState<Record<string, Record<string, boolean>>>({});
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const load = () =>
    view<PolicyData>("policy")
      .then((x) => {
        setD(x);
        setValue(x.value ?? {});
      })
      .catch(() => setMsg({ text: NOT_READY, bad: true }));
  useEffect(() => {
    load();
  }, []);
  const isOn = (mood: string, cat: string) => !!d?.allows[mood]?.includes(cat) && value[mood]?.[cat] !== false;
  const flip = (mood: string, cat: string) => setValue((v) => ({ ...v, [mood]: { ...(v[mood] ?? {}), [cat]: !isOn(mood, cat) } }));
  const save = async () => {
    const r = await act("policy.set", { value });
    setMsg(r.ok ? { text: "Saved. New games use it within a minute." } : { text: `Not saved: ${r.error}`, bad: true });
    load();
  };
  return (
    <section className="space-y-2">
      <h2 className="font-extrabold">Strictness · Spin the Bottle</h2>
      <p className="text-sm">Switch whole kinds of prompt off for a mood. This only makes a mood stricter: greyed-out boxes are never allowed in that mood.</p>
      {msg && <Msg text={msg.text} bad={msg.bad} />}
      {d && (
        <div className="overflow-x-auto">
          <table className="text-left text-sm">
            <thead>
              <tr>
                <th className="pr-3">Kind of prompt</th>
                {d.moods.map((m) => (
                  <th key={m} className="px-2">{MOOD_LABEL[m] ?? m}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {d.categories.map((c) => (
                <tr key={c.id} className="border-t border-[#1e1a17]/20">
                  <td className="pr-3">
                    <div className="font-bold">{c.label}</div>
                    <div className="text-xs">{c.hint}</div>
                  </td>
                  {d.moods.map((m) => (
                    <td key={m} className="px-2 text-center">
                      <input
                        type="checkbox"
                        aria-label={`${c.label} in ${MOOD_LABEL[m] ?? m}`}
                        className="h-5 w-5"
                        disabled={!d.allows[m]?.includes(c.id)}
                        checked={isOn(m, c.id)}
                        onChange={() => flip(m, c.id)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {d && <button className={button} onClick={save}>Save strictness</button>}
    </section>
  );
}

/* ---------------- Signals ---------------- */

interface SigRow {
  kind: string;
  category: string;
  text_key: string;
  shown: number;
  dislike: number;
  like: number;
  flipped: number;
  passed: number;
  loved: number;
  inLibrary: boolean;
}
interface SignalsData {
  tracked: number;
  rules: { minShown: number; retireRate: number; reportRooms: number };
  worst: SigRow[];
  best: SigRow[];
  switchedOff: { id: number; kind: string; category: string; text_key: string; off_reason: string; off_at: string }[];
}

function SignalsSection() {
  const [d, setD] = useState<SignalsData | null>(null);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const load = () => view<SignalsData>("signals").then(setD).catch(() => setMsg({ text: NOT_READY, bad: true }));
  useEffect(() => {
    load();
  }, []);
  const restore = async (id: number) => {
    const r = await act("signal.restore", { id });
    setMsg(r.ok ? { text: "Switched back on." } : { text: `Not changed: ${r.error}`, bad: true });
    load();
  };
  const table = (rows: SigRow[], good: boolean) => (
    <table className="w-full text-left text-sm">
      <thead>
        <tr><th>Item</th><th>Game · mood</th><th>Shown</th><th>{good ? "Done or loved" : "Flipped, passed or skipped"}</th></tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.kind}|${r.category}|${r.text_key}`} className="border-t border-[#1e1a17]/20">
            <td>{r.text_key}{r.inLibrary ? "" : <span className="text-xs"> · built-in</span>}</td>
            <td className="text-xs">{KIND_LABEL[r.kind] ?? r.kind} · {r.category}</td>
            <td className="tabular-nums">{r.shown}</td>
            <td className="tabular-nums">{pct(good ? r.like : r.dislike)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <section className="space-y-2">
      <h2 className="font-extrabold">What players like</h2>
      {d && (
        <p className="text-sm">
          {d.tracked} items tracked so far. A library item shown at least {d.rules.minShown} times that players flip or pass {pct(d.rules.retireRate)} of the time is switched off automatically. Built-in items are only shown here, so you can rewrite the weak ones.
        </p>
      )}
      {msg && <Msg text={msg.text} bad={msg.bad} />}
      {d && !d.worst.length && <p className={box}>Not enough plays yet. Items appear here after they&apos;ve been shown 5 times.</p>}
      {!!d?.worst.length && (
        <>
          <h3 className="font-bold">Skipped most</h3>
          {table(d.worst, false)}
          <h3 className="font-bold">Loved most</h3>
          {table(d.best, true)}
        </>
      )}
      {!!d?.switchedOff.length && (
        <>
          <h3 className="font-bold">Switched off automatically</h3>
          <ul className="space-y-1 text-sm">
            {d.switchedOff.map((x) => (
              <li key={x.id} className={`${box} flex items-center justify-between gap-2`}>
                <span>
                  {x.text_key} <span className="text-xs">· {KIND_LABEL[x.kind] ?? x.kind} · {x.off_reason === "reports" ? "reported" : "players skipped it"}</span>
                </span>
                <button className={button} onClick={() => restore(x.id)}>Switch back on</button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
