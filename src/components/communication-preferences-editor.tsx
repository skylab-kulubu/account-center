"use client";

import { BellOff, CornerDownRight, EyeOff, Plus, RotateCcw, UserMinus } from "lucide-react";
import { Button, Combobox, Notice, Switch, ToggleRow } from "@skylab-kulubu/skylcn-ui";
import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  categoryGroupId,
  clubCategory,
  MASTER_CATEGORY,
  NEWS_KINDS,
  parseCommunicationPreferencesView,
  preferencesLoginHref,
  PRIVACY_NOTICE_URL,
  showsTrackingSwitch,
  teamCategory,
} from "@/lib/communication-preferences";
import type {
  CommunicationPreferencesView,
  KindCells,
  NewsKind,
  PreferenceCell,
  PreferenceChange,
  PreferenceTeamRow,
  PreferenceUpdate,
} from "@/lib/communication-preferences";

type SafeProblem = { title: string; detail: string; status: number };

type Feedback =
  | { tone: "success"; message: string }
  | { tone: "danger"; problem: SafeProblem };

const ROUTE = "/api/account/communication-preferences";

const kindLabels: Readonly<Record<NewsKind, string>> = { duyuru: "Duyurular", haber: "Haberler" };

/** Word for word the privacy notice's; checked means not tracked (`tracking.enabled: false`). */
const TRACKING_LABEL = "Postalarımın açılmasını ve tıklamalarımı izleme";

const networkProblem: SafeProblem = {
  title: "Bağlantı kurulamadı",
  detail: "İsteğin sunucuya ulaşmadı; tercihlerin değişmedi. İnternet bağlantını kontrol edip yeniden dene.",
  status: 0,
};

const fallbackProblem: SafeProblem = {
  title: "Tercih kaydedilemedi",
  detail: "Tercihlerin değişmedi. Kısa bir süre sonra yeniden deneyebilirsin.",
  status: 500,
};

const contractProblem: SafeProblem = {
  title: "İletişim tercihleri güvenle durduruldu",
  detail: "Sunucu yanıtı beklenen biçimde değildi. Sayfayı yenileyip yeniden dene.",
  status: 502,
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Only bounded `title`/`detail` text reaches the DOM; anything else falls back. */
function parseProblem(value: unknown, status: number): SafeProblem {
  if (!isObject(value)) return { ...fallbackProblem, status };
  return {
    title: typeof value.title === "string" && value.title.length <= 160 ? value.title : fallbackProblem.title,
    detail: typeof value.detail === "string" && value.detail.length <= 512 ? value.detail : fallbackProblem.detail,
    status,
  };
}

type FlatRow = { row: PreferenceTeamRow; depth: number; topLevel: boolean };

function flatten(rows: readonly PreferenceTeamRow[]): FlatRow[] {
  const out: FlatRow[] = [];
  const walk = (row: PreferenceTeamRow, depth: number) => {
    out.push({ row, depth, topLevel: depth === 0 });
    for (const child of row.children) walk(child, depth + 1);
  };
  for (const row of rows) walk(row, 0);
  return out;
}

function teamNames(view: CommunicationPreferencesView) {
  const names = new Map<string, string>();
  for (const { row } of flatten([...view.teams, ...view.following])) {
    if (!row.hidden) names.set(row.groupId, row.code || row.displayName);
  }
  for (const team of view.followable) names.set(team.groupId, team.code || team.displayName);
  return names;
}

/** Every explicit choice in a followed tree, so unfollowing leaves nothing of it behind ("kaldırmak açık ayarı siler"). */
function forgetTree(row: PreferenceTeamRow): PreferenceChange[] {
  const changes: PreferenceChange[] = [];
  for (const { row: item } of flatten([row])) {
    for (const kind of NEWS_KINDS) {
      if (item === row || item.kinds[kind].explicit !== null) {
        changes.push({ category: teamCategory(item.groupId, kind), enabled: null });
      }
    }
  }
  return changes;
}

function rowLabel(row: PreferenceTeamRow) {
  return row.hidden ? row.displayName : row.code || row.displayName;
}

/** The row the mail's link names: `master`, `club` or a Group id. */
function focusKey(category: string | null) {
  if (!category) return null;
  if (category === MASTER_CATEGORY) return "master";
  if (category.startsWith("club:")) return "club";
  return categoryGroupId(category);
}

function focusLabel(category: string, view: CommunicationPreferencesView, names: Map<string, string>) {
  if (category === MASTER_CATEGORY) return "Duyuru ve haber postaları";
  const kind = category.endsWith(":haber") ? "haber" : "duyuru";
  const groupId = categoryGroupId(category);
  const source = groupId === null ? "Kulüp geneli" : names.get(groupId);
  if (groupId !== null && !source) {
    const hidden = flatten(view.following).some(({ row }) => row.groupId === groupId && row.hidden);
    return hidden ? `Gizli ekip · ${kindLabels[kind]}` : null;
  }
  return `${source} · ${kindLabels[kind]}`;
}

function CellNote({ id, cell, names }: { id: string; cell: PreferenceCell; names: Map<string, string> }) {
  if (!cell.from) return null;
  const from = names.get(cell.from);
  // One text node for screen readers: a visually hidden part inside the visible note would read as "üst ekipten : X".
  return (
    <>
      <small aria-hidden="true" className="preferences-cell__note">üst ekipten</small>
      <span className="sr-only" id={id}>{from ? `üst ekipten: ${from}` : "üst ekipten"}</span>
    </>
  );
}

type RowProps = {
  label: string;
  hint?: string;
  depth: number;
  kinds: KindCells;
  category: (kind: NewsKind) => string;
  names: Map<string, string>;
  focused: boolean;
  disabled: boolean;
  hidden?: boolean;
  /** `reset` shows only while the row holds a choice of its own. */
  action: "reset" | "unfollow" | "remove";
  onAction: () => void;
  onToggle: (category: string, label: string, enabled: boolean) => void;
  focusRef?: React.Ref<HTMLTableRowElement>;
};

const actionCopy = {
  reset: { icon: RotateCcw, text: "Varsayılana dön" },
  unfollow: { icon: UserMinus, text: "Takibi bırak" },
  remove: { icon: UserMinus, text: "Kaldır" },
} as const;

function PreferenceRow({ label, hint, depth, kinds, category, names, focused, disabled, hidden, action, onAction, onToggle, focusRef }: RowProps) {
  const id = useId();
  const showAction = action !== "reset" || NEWS_KINDS.some((kind) => kinds[kind].explicit !== null);
  const { icon: ActionIcon, text: actionText } = actionCopy[action];
  return (
    <tr className="preferences-row" data-depth={Math.min(depth, 5)} data-focused={focused || undefined} ref={focusRef}>
      <th scope="row">
        <span className="preferences-row__source">
          {depth > 0 ? <CornerDownRight aria-hidden="true" className="preferences-row__branch" size={14} /> : null}
          {hidden ? <EyeOff aria-hidden="true" className="preferences-row__branch" size={14} /> : null}
          <span className="preferences-row__copy">
            <strong>{label}</strong>
            {hint ? <small>{hint}</small> : null}
          </span>
        </span>
      </th>
      {NEWS_KINDS.map((kind) => {
        const cell = kinds[kind];
        const noteId = `${id}-${kind}`;
        const switchLabel = `${label} · ${kindLabels[kind]}`;
        return (
          <td key={kind}>
            <span className="preferences-cell">
              <Switch
                aria-describedby={cell.from ? noteId : undefined}
                aria-label={switchLabel}
                checked={cell.enabled}
                disabled={disabled || hidden}
                onCheckedChange={(checked) => onToggle(category(kind), switchLabel, checked)}
              />
              <CellNote cell={cell} id={noteId} names={names} />
            </span>
          </td>
        );
      })}
      {/* Its own column, so a screen reader reading the row header in each cell does not read the button too. */}
      <td className="preferences-row__action">
        {showAction ? (
          <Button
            aria-label={`${actionText}: ${label}`}
            disabled={disabled}
            onClick={onAction}
            size="sm"
            title={actionText}
            type="button"
            variant="ghost"
          >
            <ActionIcon aria-hidden="true" />
            <span className="preferences-row__action-text">{actionText}</span>
          </Button>
        ) : null}
      </td>
    </tr>
  );
}

type TeamRowsProps = {
  rows: readonly PreferenceTeamRow[];
  followed: boolean;
  focusKey: string | null;
  focusRef: React.Ref<HTMLTableRowElement>;
  names: Map<string, string>;
  disabled: boolean;
  onToggle: RowProps["onToggle"];
  onReset: (label: string, kinds: KindCells, category: (kind: NewsKind) => string) => void;
  onUnfollow: (row: PreferenceTeamRow) => void;
};

/** A team tree as indented rows; a followed tree's top row is where it is unfollowed. */
function TeamRows({ rows, followed, focusKey: key, focusRef, names, disabled, onToggle, onReset, onUnfollow }: TeamRowsProps) {
  return flatten(rows).map(({ row, depth, topLevel }) => {
    const label = rowLabel(row);
    const category = (kind: NewsKind) => teamCategory(row.groupId, kind);
    const unfollows = followed && topLevel;
    return (
      <PreferenceRow
        action={unfollows ? (row.hidden ? "remove" : "unfollow") : "reset"}
        category={category}
        depth={depth}
        disabled={disabled}
        focusRef={key === row.groupId ? focusRef : undefined}
        focused={key === row.groupId}
        hidden={row.hidden}
        hint={row.hidden
          ? "Artık görünmeyen bir ekip; yalnız kaldırılabilir."
          : row.code && row.code !== row.displayName ? row.displayName : undefined}
        key={row.groupId}
        kinds={row.kinds}
        label={label}
        names={names}
        onAction={unfollows ? () => onUnfollow(row) : () => onReset(label, row.kinds, category)}
        onToggle={onToggle}
      />
    );
  });
}

/** Kaynak, Duyurular, Haberler and the row's action. */
const TABLE_COLUMNS = 4;

function GroupHeading({ children }: { children: React.ReactNode }) {
  return (
    <tr className="preferences-group">
      <th colSpan={TABLE_COLUMNS} scope="rowgroup">{children}</th>
    </tr>
  );
}

function EmptyRow({ children }: { children: React.ReactNode }) {
  return (
    <tr className="preferences-empty">
      <td colSpan={TABLE_COLUMNS}>{children}</td>
    </tr>
  );
}

/**
 * The "İletişim tercihleri" editor (bilet 09, core
 * `docs/communication-preferences.md`): the master switch, the club-wide
 * row, the person's teams as a tree and the teams they follow, each with a
 * Duyurular and a Haberler switch on the e-mail channel. Every change is
 * written at once and the screen core answers replaces the local one, so
 * inherited values ("üst ekipten") and the master switch's dimming always
 * show what core will send.
 */
export function CommunicationPreferencesEditor({
  initial,
  csrfToken,
  focusCategory,
}: {
  initial: CommunicationPreferencesView;
  csrfToken: string;
  focusCategory: string | null;
}) {
  const [view, setView] = useState(initial);
  const [pending, setPending] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [followChoice, setFollowChoice] = useState<string | null>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);
  const focusedRow = useRef<HTMLTableRowElement>(null);
  const focusedMaster = useRef<HTMLDivElement>(null);
  const moveFocusToFeedback = useRef(false);
  const masterHeadingId = useId();
  const masterDescriptionId = useId();
  const tableHeadingId = useId();
  const followHeadingId = useId();
  const trackingHeadingId = useId();

  const names = useMemo(() => teamNames(view), [view]);
  const key = focusKey(focusCategory);
  const focusText = focusCategory ? focusLabel(focusCategory, view, names) : null;
  const masterOn = view.master.enabled;

  useEffect(() => {
    if (!key) return;
    const target = key === "master" ? focusedMaster.current : focusedRow.current;
    target?.scrollIntoView({ block: "center" });
  }, [key]);

  useEffect(() => {
    if (!moveFocusToFeedback.current || pending) return;
    moveFocusToFeedback.current = false;
    feedbackRef.current?.focus();
  }, [feedback, pending]);

  /** Writes the changes and shows core's new screen; `true` when they were saved. */
  async function apply(update: PreferenceChange[] | PreferenceUpdate, success: string, opts: { focusFeedback?: boolean } = {}) {
    if (pending) return false;
    const { items, tracking } = Array.isArray(update) ? { items: update, tracking: undefined } : update;
    setPending(items[0]?.category ?? "pending");
    setFeedback(null);
    moveFocusToFeedback.current = opts.focusFeedback === true;
    try {
      let response: Response;
      try {
        response = await fetch(ROUTE, {
          method: "PUT",
          cache: "no-store",
          credentials: "same-origin",
          headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
          body: JSON.stringify({
            ...(items.length > 0 ? { items } : {}),
            ...(tracking !== undefined ? { tracking: { enabled: tracking } } : {}),
          }),
        });
      } catch {
        setFeedback({ tone: "danger", problem: networkProblem });
        return false;
      }
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        // Handled below as a contract or fallback problem.
      }
      if (!response.ok) {
        moveFocusToFeedback.current = true;
        setFeedback({ tone: "danger", problem: parseProblem(body, response.status) });
        return false;
      }
      const next = isObject(body) ? parseCommunicationPreferencesView(body.preferences) : null;
      if (!next) {
        moveFocusToFeedback.current = true;
        setFeedback({ tone: "danger", problem: contractProblem });
        return false;
      }
      setView(next);
      setFeedback({ tone: "success", message: success });
      return true;
    } finally {
      setPending(null);
    }
  }

  const toggle = (category: string, label: string, enabled: boolean) =>
    void apply([{ category, enabled }], `${label} ${enabled ? "açıldı" : "kapatıldı"}.`);

  const reset = (label: string, kinds: KindCells, category: (kind: NewsKind) => string) =>
    void apply(
      NEWS_KINDS.filter((kind) => kinds[kind].explicit !== null).map((kind) => ({ category: category(kind), enabled: null })),
      `${label} varsayılana döndü.`,
    );

  const follow = () => {
    const team = view.followable.find(({ groupId }) => groupId === followChoice);
    if (!team) return;
    void apply(
      NEWS_KINDS.map((kind) => ({ category: teamCategory(team.groupId, kind), enabled: true })),
      `${team.code || team.displayName} takip ediliyor; duyuruları ve haberleri açık.`,
      { focusFeedback: true },
    ).then((saved) => {
      if (saved) setFollowChoice(null);
    });
  };

  const unfollow = (row: PreferenceTeamRow) =>
    void apply(
      forgetTree(row),
      row.hidden ? "Gizli ekip için kalan ayar silindi." : `${rowLabel(row)} artık takip edilmiyor.`,
      { focusFeedback: true },
    );

  /** Checked turns tracking off: the switch is the objection, not the tracking. */
  const objectToTracking = (checked: boolean) =>
    void apply(
      { items: [], tracking: !checked },
      checked ? "Açılma ve tıklama izlemesi kapatıldı." : "Açılma ve tıklama izlemesi açıldı.",
    );

  const busy = pending !== null;

  return (
    <>
      <div className="preferences-feedback" ref={feedbackRef} tabIndex={-1}>
        {/* In the DOM from the start, so a screen reader announces what is put in it; the Notice gives up its own role. */}
        <div aria-atomic="true" className="preferences-feedback__live" role="status">
          {feedback?.tone === "success" ? <Notice role={undefined} tone="success">{feedback.message}</Notice> : null}
        </div>
        {feedback?.tone === "danger" ? (
          <Notice
            action={feedback.problem.status === 401 ? (
              <Button render={<Link href={preferencesLoginHref(focusCategory)} />} size="sm" variant="link">Yeniden giriş yap</Button>
            ) : undefined}
            title={feedback.problem.title}
            tone="danger"
          >
            {feedback.problem.detail}
          </Notice>
        ) : null}
        {!feedback && focusText ? (
          <Notice title="Postadaki bağlantıdan geldin">
            “{focusText}” satırı aşağıda vurgulandı. Yalnız bu kategoriyi kapatmak diğer postalarını etkilemez.
          </Notice>
        ) : null}
      </div>

      <section className="settings-section" aria-labelledby={masterHeadingId}>
        <div className="settings-section__heading">
          <h2 id={masterHeadingId}>Ana anahtar</h2>
          <p>Kapatırsan aşağıdaki seçimlerin korunur; yeniden açınca hepsi geri gelir.</p>
        </div>
        <div className="preferences-master" data-focused={key === "master" || undefined} ref={focusedMaster}>
          <ToggleRow
            aria-describedby={masterDescriptionId}
            aria-label="Duyuru ve haber postaları"
            checked={masterOn}
            description={(
              <span id={masterDescriptionId}>
                {masterOn
                  ? "Açık: aşağıda açık olan kaynaklardan duyuru ve haber postası alırsın."
                  : "Kapalı: hiçbir duyuru ve haber postası gelmez."}
              </span>
            )}
            disabled={busy}
            onCheckedChange={(checked) => toggle(MASTER_CATEGORY, "Duyuru ve haber postaları", checked)}
            title="Duyuru ve haber postaları"
          />
        </div>
      </section>

      <section className="settings-section" aria-labelledby={tableHeadingId}>
        <div className="settings-section__heading">
          <h2 id={tableHeadingId}>Kaynaklar</h2>
          <p>
            Bir ekibe abonelik alt ekiplerini de kapsar; bir alt ekibi ayrıca kapatabilirsin. Değer üst ekipten geliyorsa
            “üst ekipten” yazar.
          </p>
        </div>
        {!masterOn ? (
          <Notice className="preferences-master-off" icon={BellOff} tone="warning">
            Ana anahtar kapalı: aşağıdaki ayarlar şu an bir şey göndermez ama korunur.
          </Notice>
        ) : null}
        <div className="preferences-table-frame" data-dimmed={!masterOn || undefined}>
          <table aria-busy={busy || undefined} className="preferences-table">
            <caption className="sr-only">Duyuru ve haber postası tercihlerin, kaynak kaynak</caption>
            <thead>
              <tr>
                <th scope="col">Kaynak</th>
                <th scope="col">Duyurular</th>
                <th scope="col">Haberler</th>
                <th className="preferences-table__action" scope="col"><span className="sr-only">İşlem</span></th>
              </tr>
            </thead>
            <tbody>
              <GroupHeading>Kulüp geneli</GroupHeading>
              <PreferenceRow
                action="reset"
                category={clubCategory}
                depth={0}
                disabled={busy}
                focusRef={key === "club" ? focusedRow : undefined}
                focused={key === "club"}
                hint="Tüm üyelere giden postalar"
                kinds={view.club}
                label="Kulüp geneli"
                names={names}
                onAction={() => reset("Kulüp geneli", view.club, clubCategory)}
                onToggle={toggle}
              />
            </tbody>
            <tbody>
              <GroupHeading>Ekiplerim</GroupHeading>
              {view.teams.length ? (
                <TeamRows
                  disabled={busy}
                  focusKey={key}
                  focusRef={focusedRow}
                  names={names}
                  onReset={reset}
                  onToggle={toggle}
                  onUnfollow={unfollow}
                  followed={false}
                  rows={view.teams}
                />
              ) : <EmptyRow>Henüz bir ekibin yok.</EmptyRow>}
            </tbody>
            <tbody>
              <GroupHeading>Takip ettiğim ekipler</GroupHeading>
              {view.following.length ? (
                <TeamRows
                  disabled={busy}
                  focusKey={key}
                  focusRef={focusedRow}
                  names={names}
                  onReset={reset}
                  onToggle={toggle}
                  onUnfollow={unfollow}
                  followed
                  rows={view.following}
                />
              ) : <EmptyRow>Henüz bir ekip takip etmiyorsun.</EmptyRow>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="settings-section" aria-labelledby={followHeadingId}>
        <div className="settings-section__heading">
          <h2 id={followHeadingId}>Ekip takip et</h2>
          <p>Takip ettiğin ekiplerin yalnız herkese ve tüm üyelere açık duyuruları gelir.</p>
        </div>
        {view.followable.length ? (
          <div className="preferences-follow">
            <Combobox
              aria-label="Takip edilecek ekip"
              className="preferences-follow__input"
              disabled={busy}
              emptyText="Bu adla görünen bir ekip yok."
              items={view.followable.map((team) => ({
                value: team.groupId,
                label: team.code && team.code !== team.displayName ? `${team.code} · ${team.displayName}` : team.displayName,
              }))}
              onValueChange={setFollowChoice}
              placeholder="Ekip ara"
              value={followChoice}
            />
            <Button disabled={busy || !followChoice} onClick={follow} size="lg" type="button" variant="primary">
              <Plus aria-hidden="true" />
              Takip et
            </Button>
          </div>
        ) : (
          <p className="preferences-follow__empty">Takip edebileceğin başka bir ekip yok.</p>
        )}
      </section>

      {/* Open and click tracking (hub ticket 16): its own section, untouched by the master switch. */}
      {showsTrackingSwitch(view.tracking) ? (
        <section className="settings-section" aria-labelledby={trackingHeadingId}>
          <div className="settings-section__heading">
            <h2 id={trackingHeadingId}>Postalarımın açılma ve tıklama bilgisi</h2>
            <p>
              <a href={PRIVACY_NOTICE_URL} rel="noopener noreferrer" target="_blank">KVKK aydınlatma metni</a>
            </p>
          </div>
          <ToggleRow
            aria-label={TRACKING_LABEL}
            checked={!view.tracking.enabled}
            disabled={busy}
            onCheckedChange={objectToTracking}
            title={TRACKING_LABEL}
          />
        </section>
      ) : null}
    </>
  );
}
