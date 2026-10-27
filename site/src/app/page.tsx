import { ChatApp } from "@/components/chat/ChatApp";
import { MaikoIntroPreload } from "@/components/chat/MaikoIntroPreload";
import { chooseMaikoIntro } from "@/lib/maikoIntro";

export default async function Home({ searchParams }: { searchParams: Promise<{ _desktop_ui?: string }> }) {
  const desktop = (await searchParams)._desktop_ui === "1";
  const intro = chooseMaikoIntro(Math.random());
  return <>
    {!desktop && <MaikoIntroPreload intro={intro} />}
    <ChatApp intro={intro} />
  </>;
}
