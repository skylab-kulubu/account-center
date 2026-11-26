import { ErrorScenePage } from "@skylab-kulubu/skylcn-ui";
import { Background } from "@/components/background";

export default function NotFound() {
  return (
    <div className="account-root">
      <Background />
      <ErrorScenePage className="relative z-1 bg-transparent" href="/" kind="notFound" />
    </div>
  );
}
