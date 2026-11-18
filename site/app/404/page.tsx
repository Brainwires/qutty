// The exported not-found page: out/404/index.html, which scripts/seo.ts copies to out/404.html
// for the static host (nginx's `error_page 404 /404.html`, Cloudflare and GitHub Pages).
import { Lost, LOST_METADATA } from "../../components/lost.tsx";

export const metadata = LOST_METADATA;

export default function NotFoundPage() {
  return <Lost />;
}
