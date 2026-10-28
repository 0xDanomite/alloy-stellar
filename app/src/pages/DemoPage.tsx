import { useRef } from "react";
import { Link } from "react-router-dom";
import { ArrowRight } from "../components/icons";

interface Chapter {
  at: number;
  title: string;
}

const CHAPTERS: Chapter[] = [
  { at: 0, title: "Stellar tokenized the real world" },
  { at: 4, title: "Meet Alloy" },
  { at: 10, title: "Create a fund" },
  { at: 17, title: "Net asset value" },
  { at: 29, title: "Redeem any time" },
  { at: 36, title: "Issuer rails" },
  { at: 44, title: "Live on Stellar mainnet" },
  { at: 48, title: "What's next" },
];

function timestamp(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

export function DemoPage() {
  const video = useRef<HTMLVideoElement>(null);

  function seek(at: number) {
    const player = video.current;
    if (!player) return;
    player.currentTime = at;
    void player.play();
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
      <p className="text-filing text-muted-foreground">Alloy · demo</p>
      <h1 className="mt-1 font-display text-[clamp(2rem,5vw,3rem)] leading-[1.05] font-semibold">
        See Alloy <span className="text-primary">in one minute.</span>
      </h1>
      <p className="mt-3 max-w-[40rem] text-muted-foreground">
        Many assets forged into one fund token, priced at net asset value, redeemable any hour, and live on Stellar
        mainnet.
      </p>

      <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_280px]">
        <div className="panel overflow-hidden rounded-2xl shadow-overlay">
          <video
            ref={video}
            className="block aspect-video w-full bg-black"
            src="/media/alloy-demo.mp4"
            poster="/media/alloy-demo-poster.jpg"
            controls
            playsInline
            preload="metadata"
          />
        </div>

        <nav aria-label="Chapters" className="lg:sticky lg:top-24 lg:self-start">
          <p className="text-filing text-muted-foreground">Chapters</p>
          <ol className="mt-3 space-y-1">
            {CHAPTERS.map((chapter) => (
              <li key={chapter.at}>
                <button
                  type="button"
                  onClick={() => seek(chapter.at)}
                  className="flex w-full items-baseline gap-3 rounded-md px-2 py-1.5 text-left hover:bg-secondary"
                >
                  <span className="num w-10 shrink-0 text-[0.8125rem] text-muted-foreground">{timestamp(chapter.at)}</span>
                  <span className="text-[0.9375rem]">{chapter.title}</span>
                </button>
              </li>
            ))}
          </ol>
        </nav>
      </div>

      <div className="mt-10 flex flex-wrap items-center gap-3">
        <Link to="/funds" className="inline-flex min-h-11 items-center gap-2 rounded-full bg-primary px-5 text-label text-primary-foreground shadow-sm hover:opacity-90">
          Explore live funds
          <ArrowRight className="size-4" />
        </Link>
        <Link to="/how" className="inline-flex min-h-11 items-center rounded-full border px-5 text-label hover:bg-secondary">
          How it works
        </Link>
      </div>
    </div>
  );
}
