"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { renderSVG } from "uqr";
import { errorCodeOf, OfflineError, postJson } from "./api.ts";
import { COPY } from "./copy.ts";
import { CopyButton, ErrorSummary, Field, OfflineBanner, type FieldError } from "./parts.tsx";

export type Enrolment = { totpUri: string; secret: string; backupCodes: string[] };

/** The step heading: "Step N of 3: …". Focused when the step appears, so it is announced. */
export function StepHeading({ text }: { text: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => ref.current?.focus(), [text]);
  return (
    <h2 tabIndex={-1} ref={ref}>
      {text}
    </h2>
  );
}

/**
 * Setup steps 2 and 3 (UI spec): authenticator (QR + key + confirm code), then
 * the 10 backup codes. Used after the setup link's password step, and after a
 * sign-in whose setup was never finished.
 */
export function EnrolSteps({ enrolment, onSignInAgain }: { enrolment: Enrolment; onSignInAgain: () => void }) {
  const [step, setStep] = useState<2 | 3>(2);
  return step === 2 ? (
    <AuthenticatorStep enrolment={enrolment} onDone={() => setStep(3)} onSignInAgain={onSignInAgain} />
  ) : (
    <BackupCodesStep codes={enrolment.backupCodes} />
  );
}

function AuthenticatorStep({ enrolment, onDone, onSignInAgain }: { enrolment: Enrolment; onDone: () => void; onSignInAgain: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [offline, setOffline] = useState(false);
  const qr = useMemo(() => `data:image/svg+xml;utf8,${encodeURIComponent(renderSVG(enrolment.totpUri, { border: 2 }))}`, [enrolment.totpUri]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = code.replace(/\s+/g, "");
    if (!value) return setErrors([{ field: "setup-code", message: COPY.errors.enterAppCode }]);
    setBusy(true);
    setOffline(false);
    try {
      const result = await postJson("/api/auth/setup/confirm", { code: value });
      if (result.status === 200) return onDone();
      if (result.status === 401 && errorCodeOf(result) === "unauthorized") return onSignInAgain();
      setErrors([{ field: "setup-code", message: COPY.errors.wrongAppCode }]);
    } catch (error) {
      if (error instanceof OfflineError) setOffline(true);
      else throw error;
    } finally {
      setBusy(false);
    }
  }

  const fieldError = errors.find((e) => e.field === "setup-code")?.message;
  return (
    <>
      <StepHeading text={COPY.setup.step2} />
      <OfflineBanner failed={offline} />
      <ErrorSummary errors={errors} />
      <p id="app-help">{COPY.setup.appHelp}</p>
      <img className="qr" src={qr} alt={COPY.setup.qrAlt} width={240} height={240} />
      <p>
        <span className="hint">{COPY.setup.key}</span>
        <span className="mono" id="setup-key">
          {enrolment.secret}
        </span>
      </p>
      <div className="button-row">
        <CopyButton label={COPY.setup.copyKey} text={enrolment.secret} />
      </div>
      <form onSubmit={submit} noValidate>
        <Field
          id="setup-code"
          label={COPY.setup.codeLabel}
          error={fieldError}
          inputMode="numeric"
          autoComplete="one-time-code"
          type="text"
          value={code}
          readOnly={busy}
          onChange={(e) => setCode(e.target.value)}
        />
        <button type="submit" className="button" disabled={busy}>
          {busy ? COPY.setup.checking : COPY.setup.verifyContinue}
        </button>
      </form>
    </>
  );
}

function BackupCodesStep({ codes }: { codes: string[] }) {
  const [saved, setSaved] = useState(false);
  const text = codes.join("\n");
  function download() {
    const url = URL.createObjectURL(new Blob([`Family Asset Vault backup codes\n\n${text}\n`], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = COPY.setup.downloadName;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <>
      <StepHeading text={COPY.setup.step3} />
      <p>{COPY.setup.backupHelp}</p>
      <ul className="codes mono" aria-label="Backup codes">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="button-row">
        <CopyButton label={COPY.setup.copyAll} text={text} />
        <button type="button" className="button button-secondary" onClick={download}>
          {COPY.setup.download}
        </button>
      </div>
      <label className="check">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        {COPY.setup.saved}
      </label>
      <button type="button" className="button" disabled={!saved} onClick={() => window.location.assign("/")}>
        {COPY.setup.continue}
      </button>
    </>
  );
}
