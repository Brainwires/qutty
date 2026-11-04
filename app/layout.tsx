// Root layout — denext supplies <html>/<head>/<body>; the app paints the whole window itself.
import type { LayoutProps } from "denext/server";

export const metadata = {
  title: "Qutty",
  description: "A terminal workspace that sizes tiles by recency.",
  head:
    `<link rel="icon" type="image/png" href="/favicon.png"><link rel="stylesheet" href="/xterm.css"><link rel="stylesheet" href="/styles.css">`,
};

export default function RootLayout({ children }: LayoutProps) {
  return <>{children}</>;
}
