import { SkylabLoader } from "@skylab-kulubu/skylcn-ui";

export default function Loading() {
  return (
    <div className="full-state" role="status" aria-live="polite">
      <SkylabLoader size={80} />
      <span className="sr-only">Hesap Merkezi yükleniyor</span>
    </div>
  );
}
