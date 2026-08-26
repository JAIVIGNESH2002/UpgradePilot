import { CheckCircle2 } from "lucide-react";

import { Button } from "@/components/ui/button";

const checks = ["Next.js", "TypeScript", "Tailwind CSS", "shadcn/ui"];

export default function Home() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <section className="mx-auto flex min-h-screen w-full max-w-3xl flex-col justify-center px-6 py-16">
        <div className="space-y-8">
          <div className="space-y-3">
            <p className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
              Foundation
            </p>
            <h1 className="text-4xl font-semibold tracking-normal text-balance sm:text-5xl">
              UpgradePilot
            </h1>
            <p className="max-w-2xl text-base leading-7 text-muted-foreground">
              The repository foundation is ready. Product workflows and dependency-upgrade behavior
              are intentionally not implemented yet.
            </p>
          </div>

          <ul className="grid gap-3 sm:grid-cols-2" aria-label="Configured project foundation">
            {checks.map((check) => (
              <li key={check} className="flex items-center gap-3 text-sm text-muted-foreground">
                <CheckCircle2 className="size-4 text-foreground" aria-hidden="true" />
                <span>{check}</span>
              </li>
            ))}
          </ul>

          <Button type="button" variant="outline" disabled>
            Product UI coming later
          </Button>
        </div>
      </section>
    </main>
  );
}
