// "Connect your wallet" from any screen. Inside the dashboard's trade view it is a router link to the connect
// screen; the site's own mounts (dashboard views, the risk page) pass a handler that shows their connect step.
import { createContext, useContext } from "react";
import { Link } from "react-router";

export const ConnectNav = createContext<(() => void) | null>(null);

export function ConnectLink() {
  const go = useContext(ConnectNav);
  if (go)
    return (
      <button type="button" className="link-button" onClick={go}>
        Connect your wallet
      </button>
    );
  return <Link to="/app">Connect your wallet</Link>;
}
