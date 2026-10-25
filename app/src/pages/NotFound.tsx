import { Link } from "react-router-dom";

export function NotFound({ message = "There's nothing at this address." }: { message?: string }) {
  return (
    <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6">
      <h1 className="text-title">Not here</h1>
      <p className="mt-2 max-w-prose text-muted-foreground">{message}</p>
      <Link to="/" className="mt-6 inline-block text-primary underline-offset-4 hover:underline">
        See every fund
      </Link>
    </div>
  );
}
