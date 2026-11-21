"use client";

import { useEffect, useState, type FormEvent } from "react";
import { errorCodeOf, OfflineError, postJson, type ApiResult } from "./api.ts";
import { COPY } from "./copy.ts";
import { EnrolSteps, StepHeading, type Enrolment } from "./enrol.tsx";
import { ErrorSummary, Field, OfflineBanner, type FieldError } from "./parts.tsx";

type State =
  | { name: "checking" }
  | { name: "expired" }
  | { name: "password"; token: string }
  | { name: "enrol"; enrolment: Enrolment };

/**
 * The setup link (/setup#<token>): choose a password, set up the authenticator,
 * save the backup codes (UI spec). The token is in the URL fragment, so it is
 * never sent in a request line or a Referer; it is removed from the address bar
 * at once and sent only in a POST body.
 */
export function SetupFlow() {
  const [state, setState] = useState<State>({ name: "checking" });
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const token = window.location.hash.slice(1);
    if (token) window.history.replaceState(null, "", window.location.pathname);
    if (!token) {
      setState({ name: "expired" });
      return;
    }
    postJson("/api/auth/setup/check", { token }).then(
      (result) => setState(result.status === 200 ? { name: "password", token } : { name: "expired" }),
      () => setOffline(true),
    );
  }, []);

  if (state.name === "expired") {
    return (
      <>
        <h1>{COPY.setup.expiredTitle}</h1>
        <p>{COPY.setup.expiredText}</p>
      </>
    );
  }
  return (
    <>
      <h1>{COPY.setup.title}</h1>
      {state.name === "checking" ? (
        <OfflineBanner failed={offline} />
      ) : state.name === "password" ? (
        <PasswordStep token={state.token} onExpired={() => setState({ name: "expired" })} onDone={(enrolment) => setState({ name: "enrol", enrolment })} />
      ) : (
        <EnrolSteps enrolment={state.enrolment} onSignInAgain={() => window.location.assign("/sign-in?reason=again")} />
      )}
    </>
  );
}

function PasswordStep({ token, onExpired, onDone }: { token: string; onExpired: () => void; onDone: (e: Enrolment) => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [offline, setOffline] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const problems: FieldError[] = [];
    if ([...password].length < 12) problems.push({ field: "new-password", message: COPY.errors.tooShort });
    if (password !== confirm || !confirm) problems.push({ field: "confirm-password", message: COPY.errors.mismatch });
    setErrors(problems);
    if (problems.length) return;
    setBusy(true);
    setOffline(false);
    let result: ApiResult;
    try {
      result = await postJson("/api/auth/setup/password", { token, password });
    } catch (error) {
      setBusy(false);
      if (error instanceof OfflineError) return setOffline(true);
      throw error;
    }
    setBusy(false);
    if (result.status === 200) return onDone(result.body.enrolment as Enrolment);
    if (result.status === 410) return onExpired();
    const code = errorCodeOf(result);
    setErrors([{ field: "new-password", message: code === "password_too_common" ? COPY.errors.tooCommon : COPY.errors.tooShort }]);
  }

  const errorFor = (field: string) => errors.find((e) => e.field === field)?.message;
  return (
    <>
      <StepHeading text={COPY.setup.step1} />
      <form onSubmit={submit} noValidate>
        <OfflineBanner failed={offline} />
        <ErrorSummary errors={errors} />
        <Field
          id="new-password"
          label={COPY.setup.newPassword}
          hint={COPY.setup.rule}
          type={show ? "text" : "password"}
          autoComplete="new-password"
          maxLength={128}
          value={password}
          readOnly={busy}
          error={errorFor("new-password")}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Field
          id="confirm-password"
          label={COPY.setup.confirmPassword}
          type={show ? "text" : "password"}
          autoComplete="new-password"
          maxLength={128}
          value={confirm}
          readOnly={busy}
          error={errorFor("confirm-password")}
          onChange={(e) => setConfirm(e.target.value)}
        />
        <p>
          <button type="button" className="link" aria-pressed={show} onClick={() => setShow((s) => !s)}>
            {COPY.setup.show}
          </button>
        </p>
        <button type="submit" className="button" disabled={busy}>
          {busy ? COPY.setup.saving : COPY.setup.continue}
        </button>
      </form>
    </>
  );
}
