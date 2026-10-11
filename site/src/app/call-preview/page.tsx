import { notFound } from "next/navigation";
import { CallLayoutPreview } from "@/components/chat/CallLayoutPreview";

export default async function CallPreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ minimized?: string }>;
}) {
  if (process.env.NODE_ENV !== "development") notFound();
  const params = await searchParams;
  return <CallLayoutPreview initialMinimized={params.minimized === "1"} />;
}
