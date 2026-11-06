import { Link } from "react-router";

export function NotFound() {
  return (
    <article className="page">
      <h1>Page not found</h1>
      <p>
        <Link to="/">Back to the home page</Link>
      </p>
    </article>
  );
}
