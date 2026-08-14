import { useState, type FormEvent } from "react";
import { Button } from "../ui/Button";

/** Raw form fields. The sender is the connected wallet, supplied by the caller. */
export type CreateStreamFormValues = {
  receiver: string;
  token: string;
  amount: string;
  duration: string;
};

const emptyForm: CreateStreamFormValues = {
  receiver: "",
  token: "",
  amount: "",
  duration: "",
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
        <Button type="submit" disabled={creating}>
          {creating ? "Submitting…" : "Lock & stream"}
        </Button>
      </form>
    </section>
  );
}
