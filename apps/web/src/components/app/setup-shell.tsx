import type { ReactNode } from "react";

/** The setup pages' frame: the sign-in page's, with room for a form. */
export function SetupShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="sign-in setup">
      <div className="shell">
        <a href="/" className="sign-in-mark" aria-label="RedNest home">
          <img src="/red.png" alt="RedNest" width={184} height={46} />
        </a>
        <h1 className="sign-in-title">{title}</h1>
        {children}
      </div>
    </main>
  );
}
