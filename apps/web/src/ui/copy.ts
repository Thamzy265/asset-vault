/** Every visible string on the sign-in screens, exactly as in docs/ui/m1-3-sign-in.md. */
export const COPY = {
  signIn: { title: "Sign in", email: "Email", password: "Password", button: "Sign in", busy: "Signing in…" },
  code: {
    title: "Enter your code",
    help: "Open your authenticator app and enter the 6-digit code for Family Asset Vault.",
    label: "6-digit code",
    button: "Verify",
    busy: "Checking…",
    useBackup: "Use a backup code",
  },
  backup: {
    title: "Use a backup code",
    help: "Enter one of the backup codes you saved when you set up your account. Each code works once.",
    label: "Backup code",
    button: "Verify",
    busy: "Checking…",
    useApp: "Use your authenticator app instead",
  },
  setup: {
    title: "Set up your account",
    step1: "Step 1 of 3: Choose a password",
    step2: "Step 2 of 3: Set up your authenticator app",
    step3: "Step 3 of 3: Save your backup codes",
    newPassword: "New password",
    confirmPassword: "Confirm new password",
    rule: "At least 12 characters",
    show: "Show password",
    continue: "Continue",
    saving: "Saving…",
    appHelp:
      "Open your authenticator app (for example Google Authenticator, Microsoft Authenticator or 1Password), add an account and scan this code. If you can't scan it, enter the key below instead.",
    qrAlt: "QR code for your authenticator app",
    key: "Key",
    copyKey: "Copy key",
    codeLabel: "6-digit code",
    verifyContinue: "Verify and continue",
    checking: "Checking…",
    backupHelp: "Each code works once. Keep them somewhere safe, like a password manager or printed with your important papers.",
    copyAll: "Copy all",
    download: "Download as text",
    downloadName: "family-asset-vault-backup-codes.txt",
    saved: "I've saved these codes",
    expiredTitle: "This link has expired",
    expiredText: "This setup link has expired or was already used. Ask your admin for a new one.",
  },
  copied: "Copied",
  copiedAnnouncement: "Copied to clipboard",
  copyFailed: "Couldn't copy. Select the text and copy it yourself.",
  errorSummary: "There is a problem",
  errors: {
    enterEmail: "Enter your email",
    enterPassword: "Enter your password",
    credentials: "Email or password is not right.",
    enterCode: "Enter the 6-digit code from your authenticator app",
    wrongCode: "That code is not right. Codes change every 30 seconds — try the newest one.",
    enterBackup: "Enter one of your backup codes",
    wrongBackup: "That backup code is not right or was already used.",
    mismatch: "Passwords don't match",
    tooShort: "Use at least 12 characters",
    tooLong: "Use no more than 128 characters",
    tooCommon: "This password is too common — choose another",
    enterAppCode: "Enter the code your app shows",
    wrongAppCode: "That code is not right. Check your phone's time is set automatically.",
    generic: "Something went wrong. Reload the page.",
    setupUnfinished: "Your account setup isn't finished. Open your setup link again, or ask your admin for a new one.",
  },
  notices: {
    signedOut: "You're signed out.",
    ended: "Your session ended. Please sign in again.",
    again: "Please sign in again.",
    offline: "You're offline. Check your connection and try again.",
    tryAgain: "Try again",
    signOutFailed: "We couldn't sign you out. Check your connection and try again.",
  },
  home: {
    welcome: "Welcome,",
    signOut: "Sign out",
    signOutAll: "Sign out of all devices",
    loading: "Loading your name",
  },
} as const;

/** The backup-codes-left notice (lead decision 2026-11-21). */
export function codesLeftText(n: number): string {
  if (n <= 0) return "You have no backup codes left. Ask your admin to reset your two-step sign-in.";
  const first = n === 1 ? "You have 1 backup code left." : `You have ${n} backup codes left.`;
  return `${first} When you run low, ask your admin to reset your two-step sign-in.`;
}
