import { SetupFlow } from "../../ui/setup.tsx";

/** The one-time setup link from `pnpm user:create` (M1.3): /setup#<token>. */
export default function SetupPage() {
  return (
    <main className="page">
      <div className="card">
        <SetupFlow />
      </div>
    </main>
  );
}
