// The floating companion's window (`/companion`, Settings → Companion → Floating): a Server
// Component shell around its island (app/companion/floating-companion.tsx). The app opens it
// (desktop/companion-window.ts); it is never a workspace.
import type { PageProps } from "denext/server";
import { FloatingCompanion } from "./floating-companion.tsx";

export const metadata = { title: "Companion" };

export default function CompanionPage(_props: PageProps) {
  return <FloatingCompanion />;
}
