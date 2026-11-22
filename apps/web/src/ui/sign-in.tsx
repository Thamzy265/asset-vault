"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { errorCodeOf, OfflineError, postJson, retryText, type ApiResult } from "./api.ts";
import { COPY } from "./copy.ts";
import { Banner, ErrorSummary, Field, OfflineBanner, type FieldError } from "./parts.tsx";

type Step = { name: "credentials" } | { name: "code" } | { name: "backup" };

export const CODES_LEFT_KEY = "vault.backupCodesLeft";

/** The h1 for each step, focused when the step changes so a screen reader announces it. */
function Title({ text, focus }: { text: string; focus: boolean }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focus) ref.current?.focus();
  }, [text, focus]);
  return (
    <h1 tabIndex={-1} ref={ref}>
      {text}
    </h1>
  );
}

/**
 * Sign in -> 6-digit code (or a backup code) -> home (UI spec flow). A person
 * whose setup was never finished is told to open their setup link again: the
 * password alone never resumes setup (lead decision 5).
 */
export function SignInFlow({ notice }: { notice: string | null }) {
  const [step, setStep] = useState<Step>({ name: "credentials" });
  const [message, setMessage] = useState<{ kind: "error" | "notice"; text: string } | null>(notice ? { kind: "notice", text: notice } : null);
  const [moved, setMoved] = useState(false);

  const go = (next: Step, banner: typeof message = null) => {
    setMessage(banner);
    setMoved(true);
    setStep(next);
  };
  const again = () => go({ name: "credentials" }, { kind: "notice", text: COPY.notices.again });

  const title = step.name === "credentials" ? COPY.signIn.title : step.name === "code" ? COPY.code.title : COPY.backup.title;
  return (
    <>
      <Title text={title} focus={moved} />
      {message ? <Banner kind={message.kind}>{message.text}</Banner> : null}
      {step.name === "credentials" ? (
        <CredentialsForm onNext={(s) => go(s)} onMessage={setMessage} />
      ) : step.name === "code" ? (
        <CodeForm kind="totp" onSwitch={() => go({ name: "backup" })} onSignInAgain={again} onMessage={setMessage} />
      ) : (
        <CodeForm kind="backup" onSwitch={() => go({ name: "code" })} onSignInAgain={again} onMessage={setMessage} />
      )}
    </>
  );
}

type Message = { kind: "error" | "notice"; text: string } | null;

function CredentialsForm({ onNext, onMessage }: { onNext: (step: Step) => void; onMessage: (m: Message) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [offline, setOffline] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const missing: FieldError[] = [];
    if (!email.trim()) missing.push({ field: "email", message: COPY.errors.enterEmail });
    if (!password) missing.push({ field: "password", message: COPY.errors.enterPassword });
    setErrors(missing);
    if (missing.length) return onMessage(null);
    setBusy(true);
    setOffline(false);
    let result: ApiResult;
    try {
      result = await postJson("/api/auth/sign-in", { email, password });
    } catch (error) {
      setBusy(false);
      if (error instanceof OfflineError) return setOffline(true);
      throw error;
    }
    setBusy(false);
    if (result.status === 200 && result.body.next === "code") return onNext({ name: "code" });
    if (result.status === 429) return onMessage({ kind: "error", text: retryText(result) });
    if (result.status === 403 && errorCodeOf(result) === "setup_unfinished") return onMessage({ kind: "error", text: COPY.errors.setupUnfinished });
    if (result.status === 401 || result.status === 400) return onMessage({ kind: "error", text: COPY.errors.credentials });
    onMessage({ kind: "error", text: COPY.errors.generic });
  }

  const errorFor = (field: string) => errors.find((e) => e.field === field)?.message;
  return (
    <form onSubmit={submit} noValidate>
      <OfflineBanner failed={offline} />
      <ErrorSummary errors={errors} />
      <Field id="email" label={COPY.signIn.email} type="email" autoComplete="email" value={email} readOnly={busy} error={errorFor("email")} onChange={(e) => setEmail(e.target.value)} />
      <Field
        id="password"
        label={COPY.signIn.password}
        type="password"
        autoComplete="current-password"
        value={password}
        readOnly={busy}
        error={errorFor("password")}
        onChange={(e) => setPassword(e.target.value)}
      />
      <button type="submit" className="button" disabled={busy}>
        {busy ? COPY.signIn.busy : COPY.signIn.button}
      </button>
    </form>
  );
}

function CodeForm({
  kind,
  onSwitch,
  onSignInAgain,
  onMessage,
}: {
  kind: "totp" | "backup";
  onSwitch: () => void;
  onSignInAgain: () => void;
  onMessage: (m: Message) => void;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [offline, setOffline] = useState(false);
  const text = kind === "totp" ? COPY.code : COPY.backup;
  const id = kind === "totp" ? "code" : "backup-code";

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = kind === "totp" ? code.replace(/\s+/g, "") : code.trim();
    if (!value) {
      setErrors([{ field: id, message: kind === "totp" ? COPY.errors.enterCode : COPY.errors.enterBackup }]);
      return onMessage(null);
    }
    setBusy(true);
    setOffline(false);
    let result: ApiResult;
    try {
      result = await postJson(kind === "totp" ? "/api/auth/two-factor/totp" : "/api/auth/two-factor/backup-code", { code: value });
    } catch (error) {
      setBusy(false);
      if (error instanceof OfflineError) return setOffline(true);
      throw error;
    }
    setBusy(false);
    if (result.status === 200) {
      if (typeof result.body.backupCodesLeft === "number") {
        try {
          sessionStorage.setItem(CODES_LEFT_KEY, String(result.body.backupCodesLeft));
        } catch {
          // The notice is a convenience; signing in works without it.
        }
      }
      window.location.assign("/");
      return;
    }
    if (result.status === 429) return onMessage({ kind: "error", text: retryText(result) });
    if (errorCodeOf(result) === "sign_in_again") return onSignInAgain();
    onMessage(null);
    setErrors([{ field: id, message: kind === "totp" ? COPY.errors.wrongCode : COPY.errors.wrongBackup }]);
  }

  return (
    <>
      <p id={`${id}-help`}>{text.help}</p>
      <form onSubmit={submit} noValidate>
        <OfflineBanner failed={offline} />
        <ErrorSummary errors={errors} />
        <Field
          id={id}
          label={text.label}
          type="text"
          inputMode={kind === "totp" ? "numeric" : "text"}
          autoComplete="one-time-code"
          autoCapitalize="none"
          spellCheck={false}
          value={code}
          readOnly={busy}
          error={errors[0]?.message}
          onChange={(e) => setCode(e.target.value)}
        />
        <button type="submit" className="button" disabled={busy}>
          {busy ? text.busy : text.button}
        </button>
      </form>
      <p>
        <button type="button" className="link" onClick={onSwitch}>
          {kind === "totp" ? COPY.code.useBackup : COPY.backup.useApp}
        </button>
      </p>
    </>
  );
}
