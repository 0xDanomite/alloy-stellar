import { Link } from "react-router-dom";
import { ArrowRight } from "../components/icons";

export function DemoPage() {
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

      <div className="panel mt-8 overflow-hidden rounded-2xl shadow-overlay">
        <video
          className="block aspect-video w-full bg-black"
          src="/media/alloy-demo.mp4"
          poster="/media/alloy-demo-poster.jpg"
          controls
          playsInline
          preload="metadata"
        />
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
