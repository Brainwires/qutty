// The only route. A Server Component shell (pre-rendered into the static export) around the
// workspace island, which is where everything interactive lives.
import type { PageProps } from "denext/server";
import { Workspace } from "./workspace.tsx";

export const metadata = { title: "Qutty" };

export default function Home(_props: PageProps) {
  return <Workspace />;
}
