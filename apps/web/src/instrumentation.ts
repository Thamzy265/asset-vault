export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { runNodeStartup } = await import("./instrumentation-node.ts");
    runNodeStartup();
  }
}
