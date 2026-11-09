import { useState, type FormEvent } from "react";
import { useTokenMeta } from "../../hooks/useTokenMeta";
import {
  formatDuration,
  fromDateTimeLocal,
  parseUnits,
  toDateTimeLocal,
} from "../../lib/format";
import type { CreateStreamParams } from "../../types";
import { Button } from "../ui/Button";

type DurationUnit = "minutes" | "hours" | "days" | "weeks";

const UNIT_SECONDS: Record<DurationUnit, number> = {
  minutes: 60,
  hours: 3_600,
  days: 86_400,
  weeks: 604_800,
};

/** Raw form fields. The sender is the connected wallet, supplied by the caller. */
export type CreateStreamFormValues = {
  receiver: string;
  token: string;
  /** Human decimal amount, e.g. `1.5` (converted with the token's decimals). */
  amount: string;
  durationValue: string;
  durationUnit: DurationUnit;
  /** `datetime-local` value; empty means "start now". */
  startAt: string;
  /** `datetime-local` value; empty means "no cliff". */
  cliffAt: string;
};

/** What the form hands back — everything `create_stream*` needs except sender. */
export type CreateStreamDraft = Omit<CreateStreamParams, "sender">;

const emptyForm: CreateStreamFormValues = {
  receiver: "",
  token: "",
  amount: "",
  durationValue: "30",
  durationUnit: "days",
  startAt: "",
  cliffAt: "",
};

const isContractId = (value: string) => /^C[A-Z2-7]{55}$/.test(value);

/**
 * Create-stream form.
 *
 * Inputs are human-facing: the amount is a decimal in the token's own units
 * (decimals read from the token contract), the term is a number + unit, and the
 * optional start/cliff are real date-time pickers — no raw seconds or base-unit
 * strings. All conversions and cross-field checks happen here so the contract
 * never has to reject a form the user thought was valid.
 */
export function CreateStreamForm({
  creating,
  walletAddress,
  onSubmit,
}: {
  creating: boolean;
  walletAddress?: string;
  onSubmit: (draft: CreateStreamDraft) => Promise<boolean>;
}) {
  const [form, setForm] = useState<CreateStreamFormValues>(emptyForm);
  const [error, setError] = useState<string | null>(null);

  const token = form.token.trim();
  const meta = useTokenMeta(isContractId(token) ? token : undefined, walletAddress);
  const decimals = meta.data?.decimals ?? 7;
  const symbol = meta.data?.symbol ?? "tokens";

  const durationSeconds = Number(form.durationValue) * UNIT_SECONDS[form.durationUnit];
  const startPreview =
    form.startAt === "" ? "now" : toDateTimeLocal(fromDateTimeLocalSafe(form.startAt));

  /** Build a validated draft, throwing a user-facing message on bad input. */
  const buildDraft = (): CreateStreamDraft => {
    if (!isContractId(token)) {
      throw new Error("Enter the token's contract id (C…).");
    }
    let amount: bigint;
    try {
      amount = parseUnits(form.amount, decimals);
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
    if (amount <= 0n) throw new Error("Enter an amount greater than zero.");
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new Error("Enter a duration longer than zero.");
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    let startTime: number | undefined;
    if (form.startAt) {
      startTime = fromDateTimeLocal(form.startAt);
      if (startTime <= nowSeconds) {
        throw new Error("The start time must be in the future.");
      }
    }

    let cliffSeconds: number | undefined;
    if (form.cliffAt) {
      const cliffAt = fromDateTimeLocal(form.cliffAt);
      const anchor = startTime ?? nowSeconds;
      if (cliffAt <= anchor) {
        throw new Error("The cliff must come after the stream starts.");
      }
      const seconds = cliffAt - anchor;
      if (seconds > durationSeconds) {
        throw new Error("The cliff cannot be later than the stream's end.");
      }
      cliffSeconds = seconds;
    }

    return {
      receiver: form.receiver.trim(),
      token,
      amount: amount.toString(),
      durationSeconds,
      ...(startTime != null ? { startTime } : {}),
      ...(cliffSeconds != null ? { cliffSeconds } : {}),
    };
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      if (await onSubmit(buildDraft())) setForm(emptyForm);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section className="panel">
      <h2>Create a stream</h2>
      <form className="grid" onSubmit={handleSubmit}>
        <label>
          Receiver (G…)
          <input
            required
            placeholder="GBVZ…"
            value={form.receiver}
            onChange={(e) => setForm({ ...form, receiver: e.target.value })}
          />
        </label>
        <label>
          Token contract (C…)
          <input
            required
            placeholder="C… (SAC-wrapped asset or SEP-41 token)"
            value={form.token}
            onChange={(e) => setForm({ ...form, token: e.target.value })}
          />
          <span className="muted">
            {meta.isLoading
              ? "Reading token metadata…"
              : meta.data?.resolved
                ? `${meta.data.symbol} · ${meta.data.decimals} decimals`
                : "Metadata unavailable — assuming 7 decimals."}
          </span>
        </label>
        <label>
          Amount ({symbol})
          <input
            required
            inputMode="decimal"
            placeholder={decimals === 0 ? "100" : "1.5"}
            value={form.amount}
            onChange={(e) => setForm({ ...form, amount: e.target.value })}
          />
        </label>
        <label>
          Duration
          <span className="row">
            <input
              required
              type="number"
              min="1"
              step="1"
              value={form.durationValue}
              onChange={(e) => setForm({ ...form, durationValue: e.target.value })}
            />
            <select
              value={form.durationUnit}
              onChange={(e) =>
                setForm({ ...form, durationUnit: e.target.value as DurationUnit })
              }
            >
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
              <option value="days">days</option>
              <option value="weeks">weeks</option>
            </select>
          </span>
          <span className="muted">= {formatDuration(durationSeconds)}</span>
        </label>
        <label>
          Start (optional)
          <input
            type="datetime-local"
            value={form.startAt}
            onChange={(e) => setForm({ ...form, startAt: e.target.value })}
          />
          <span className="muted">
            {form.startAt
              ? `Starts ${startPreview} — nothing accrues before then.`
              : "Blank starts immediately."}
          </span>
        </label>
        <label>
          Cliff (optional)
          <input
            type="datetime-local"
            value={form.cliffAt}
            onChange={(e) => setForm({ ...form, cliffAt: e.target.value })}
          />
          <span className="muted">
            Nothing is withdrawable before this moment; vesting still runs from
            the start, so the pre-cliff portion unlocks at once.
          </span>
        </label>

        {error && <p className="banner error">{error}</p>}

        <Button type="submit" disabled={creating}>
          {creating
            ? "Submitting…"
            : `Lock ${form.amount || "0"} ${symbol} for ${formatDuration(durationSeconds)}`}
        </Button>
      </form>
    </section>
  );
}

/** `fromDateTimeLocal` that returns `0` instead of throwing (for previews). */
function fromDateTimeLocalSafe(value: string): number {
  try {
    return fromDateTimeLocal(value);
  } catch {
    return 0;
  }
}
