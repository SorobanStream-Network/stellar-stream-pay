import { useState, type FormEvent } from "react";
import { formatWhen } from "../../lib/format";
import { Button } from "../ui/Button";

/** Raw form fields. The sender is the connected wallet, supplied by the caller. */
export type CreateStreamFormValues = {
  receiver: string;
  token: string;
  amount: string;
  duration: string;
  /** Seconds from now until the stream starts. Empty or 0 = start now. */
  startIn: string;
  /** Seconds after the start before anything unlocks. Empty = no cliff. */
  cliff: string;
};

const emptyForm: CreateStreamFormValues = {
  receiver: "",
  token: "",
  amount: "",
  duration: "",
  startIn: "",
  cliff: "",
};

/**
 * Form for creating a stream. Owns its field state and resets on a successful
 * submission (when `onSubmit` resolves `true`).
 */
export function CreateStreamForm({
  creating,
  onSubmit,
}: {
  creating: boolean;
  onSubmit: (values: CreateStreamFormValues) => Promise<boolean>;
}) {
  const [form, setForm] = useState<CreateStreamFormValues>(emptyForm);

  // `start_time` is an absolute unix timestamp on-chain and may not be in the
  // past (`StartTimeInPast`, #21). The form collects a *relative* delay, so it
  // is never negative; the submit path anchors it to "now".
  const startInSeconds = form.startIn.trim() === "" ? 0 : Number(form.startIn);
  const startInvalid =
    form.startIn.trim() !== "" &&
    (!Number.isInteger(startInSeconds) || startInSeconds < 0);

  // The contract rejects a cliff longer than the duration (`InvalidCliff`, #22);
  // catching it here saves the user a wallet round-trip.
  const cliffSeconds =
    form.cliff.trim() === "" ? null : Number(form.cliff);
  const cliffInvalid =
    cliffSeconds !== null &&
    (!Number.isInteger(cliffSeconds) ||
      cliffSeconds < 0 ||
      cliffSeconds > Number(form.duration));
  const invalid = startInvalid || cliffInvalid;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (await onSubmit(form)) {
      setForm(emptyForm);
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
        </label>
        <label>
          Amount (base units)
          <input
            required
            inputMode="numeric"
            placeholder="1000000000"
            value={form.amount}
            onChange={(e) => setForm({ ...form, amount: e.target.value })}
          />
        </label>
        <label>
          Duration (seconds)
          <input
            required
            type="number"
            min="1"
            placeholder="2592000"
            value={form.duration}
            onChange={(e) => setForm({ ...form, duration: e.target.value })}
          />
        </label>
        <label>
          Start in (seconds, optional)
          <input
            type="number"
            min="0"
            placeholder="0 — now"
            value={form.startIn}
            onChange={(e) => setForm({ ...form, startIn: e.target.value })}
          />
          <span className="muted">
            {startInvalid
              ? "The start delay must be a whole, non-negative number of seconds."
              : startInSeconds > 0
                ? `Starts ≈ ${formatWhen(
                    String(Math.floor(Date.now() / 1000) + startInSeconds),
                  )} (anchored at signing time) — nothing accrues before then.`
                : "Blank or 0 starts immediately."}
          </span>
        </label>
        <label>
          Cliff (seconds, optional)
          <input
            type="number"
            min="0"
            placeholder="0 — nothing locked"
            value={form.cliff}
            onChange={(e) => setForm({ ...form, cliff: e.target.value })}
          />
          <span className="muted">
            {cliffInvalid
              ? "The cliff must be a whole number of seconds no longer than the duration."
              : "Nothing is withdrawable until the cliff passes; vesting still runs from the start."}
          </span>
        </label>
        <Button type="submit" disabled={creating || invalid}>
          {creating ? "Submitting…" : "Lock & stream"}
        </Button>
      </form>
    </section>
  );
}
