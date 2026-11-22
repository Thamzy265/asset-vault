"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type InputHTMLAttributes, type ReactNode, type RefObject } from "react";
import { COPY } from "./copy.ts";

/** A labelled field with its hint and error wired up with aria-describedby (UI spec, accessibility notes). */
export function Field({
  id,
  label,
  error,
  hint,
  inputRef,
  ...input
}: { id: string; label: string; error?: string | undefined; hint?: string; inputRef?: RefObject<HTMLInputElement | null> } & InputHTMLAttributes<HTMLInputElement>) {
  const described = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} name={id} ref={inputRef} aria-invalid={error ? true : undefined} aria-describedby={described} {...input} />
      {hint ? (
        <span id={`${id}-hint`} className="hint">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={`${id}-error`} className="field-error">
          {error}
        </span>
      ) : null}
    </div>
  );
}

export type FieldError = { field: string; message: string };

/** "There is a problem" + links to each field's error; focus moves to the heading. */
export function ErrorSummary({ errors }: { errors: FieldError[] }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (errors.length) heading.current?.focus();
  }, [errors]);
  if (!errors.length) return null;
  return (
    <div className="banner banner-error" role="alert" aria-labelledby="error-summary-title">
      <h2 id="error-summary-title" tabIndex={-1} ref={heading}>
        {COPY.errorSummary}
      </h2>
      <ul>
        {errors.map((e) => (
          <li key={e.field}>
            <a href={`#${e.field}`}>{e.message}</a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A message not tied to one field (wrong password, rate limit, sign in again). Focus moves to it when it is an error. */
export function Banner({ kind, children }: { kind: "error" | "notice"; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (kind === "error") ref.current?.focus();
  }, [kind, children]);
  return (
    <div ref={ref} tabIndex={-1} className={kind === "error" ? "banner banner-error" : "banner"} role={kind === "error" ? "alert" : "status"}>
      {children}
    </div>
  );
}

function subscribe(callback: () => void) {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
}

/** Shown while the browser is offline, or after a request could not reach the server. */
export function OfflineBanner({ failed = false, onRetry }: { failed?: boolean; onRetry?: () => void }) {
  const online = useOnline();
  if (online && !failed) return null;
  return (
    <div className="banner banner-error" role="alert">
      {COPY.notices.offline}
      {onRetry ? (
        <>
          {" "}
          <button type="button" className="link" onClick={onRetry}>
            {COPY.notices.tryAgain}
          </button>
        </>
      ) : null}
    </div>
  );
}

/** "Copy key" / "Copy all": "Copied" for 3 s and a polite announcement; or the failure text. */
export function CopyButton({ label, text, describedBy }: { label: string; text: string; describedBy?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state !== "copied") return;
    const timer = setTimeout(() => setState("idle"), 3000);
    return () => clearTimeout(timer);
  }, [state]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
  }
  return (
    <>
      <button type="button" className="button button-secondary" onClick={copy} aria-describedby={describedBy}>
        {state === "copied" ? COPY.copied : label}
      </button>
      <span className="visually-hidden" aria-live="polite">
        {state === "copied" ? COPY.copiedAnnouncement : ""}
      </span>
      {state === "failed" ? (
        <span className="field-error" role="alert">
          {COPY.copyFailed}
        </span>
      ) : null}
    </>
  );
}
