import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from "react-native";

import { COLORS } from "../lib/config";

/**
 * Driver-app primitives.
 *
 * Two rules drive the look, and both come from where this app is used — one
 * hand, in a cab, in daylight:
 *
 *   * **Depth instead of outlines.** The screen sits on a tinted surface and
 *     cards float on it with a soft, brand-tinted shadow. Hairline borders on
 *     a white page read as a form; layered surfaces read as an app.
 *   * **One thing is obviously the biggest.** Type steps hard between levels
 *     rather than drifting, so the driver's eye lands on the duty state before
 *     anything else without having to read.
 */

/* --- Elevation ------------------------------------------------------------ */

/** Indigo-tinted rather than neutral black, so lift belongs to the palette. */
export const ELEVATION = {
  card: Platform.select({
    android: { elevation: 2 },
    default: {
      shadowColor: COLORS.accent,
      shadowOpacity: 0.1,
      shadowRadius: 16,
      shadowOffset: { width: 0, height: 4 },
    },
  }),
  raised: Platform.select({
    android: { elevation: 6 },
    default: {
      shadowColor: COLORS.accent,
      shadowOpacity: 0.22,
      shadowRadius: 22,
      shadowOffset: { width: 0, height: 8 },
    },
  }),
} as const;

/* --- Layout --------------------------------------------------------------- */

/** Page title. Tight leading is the most characteristic thing about the type. */
export function Title({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <View style={{ gap: 6, marginBottom: 4 }}>
      <Text style={styles.title}>{children}</Text>
      {sub ? <Text style={styles.subtitle}>{sub}</Text> : null}
    </View>
  );
}

/** Small all-caps label that separates groups without drawing a line. */
export function SectionLabel({ children }: { children: ReactNode }) {
  return <Text style={styles.sectionLabel}>{children}</Text>;
}

export function Card({
  children,
  style,
  tone = "plain",
}: {
  children: ReactNode;
  style?: object;
  tone?: "plain" | "accent";
}) {
  return (
    <View
      style={[
        styles.card,
        ELEVATION.card,
        tone === "accent" && { backgroundColor: COLORS.accentSoft },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/* --- Button --------------------------------------------------------------- */

export function Button({
  title,
  onPress,
  variant = "primary",
  size = "md",
  loading,
  disabled,
  icon,
}: {
  title: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "danger" | "ghost" | "success";
  size?: "md" | "lg";
  loading?: boolean;
  disabled?: boolean;
  icon?: ReactNode;
}) {
  const isDisabled = disabled || loading;
  const palette = {
    primary: { bg: COLORS.accentFill, fg: COLORS.white, border: "transparent" },
    success: { bg: COLORS.success, fg: COLORS.white, border: "transparent" },
    secondary: { bg: COLORS.surface, fg: COLORS.ink, border: COLORS.stroke },
    danger: { bg: COLORS.dangerSoft, fg: COLORS.danger, border: "transparent" },
    ghost: { bg: "transparent", fg: COLORS.ink2, border: "transparent" },
  }[variant];

  const lifted = variant === "primary" || variant === "success";

  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      style={({ pressed }) => [
        styles.button,
        size === "lg" && styles.buttonLg,
        {
          backgroundColor: palette.bg,
          borderColor: palette.border,
          opacity: isDisabled ? 0.45 : 1,
          transform: [{ scale: pressed && !isDisabled ? 0.985 : 1 }],
        },
        lifted && !isDisabled ? ELEVATION.raised : null,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={palette.fg} size="small" />
      ) : (
        <>
          {icon}
          <Text
            style={[
              styles.buttonText,
              size === "lg" && styles.buttonTextLg,
              { color: palette.fg },
            ]}
          >
            {title}
          </Text>
        </>
      )}
    </Pressable>
  );
}

/* --- Field ---------------------------------------------------------------- */

export function Field({
  label,
  hint,
  error,
  ...rest
}: TextInputProps & { label: string; hint?: string; error?: string }) {
  return (
    <View style={{ gap: 7 }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        {...rest}
        accessibilityLabel={label}
        placeholderTextColor={COLORS.ink3}
        style={[styles.input, error ? { borderColor: COLORS.danger } : null]}
      />
      {error ? (
        <Text style={[styles.hint, { color: COLORS.danger }]}>{error}</Text>
      ) : hint ? (
        <Text style={styles.hint}>{hint}</Text>
      ) : null}
    </View>
  );
}

/* --- Status --------------------------------------------------------------- */

export type Tone = "ok" | "warn" | "critical" | "idle" | "accent";

const TONES: Record<Tone, { fg: string; bg: string }> = {
  ok: { fg: COLORS.success, bg: COLORS.successSoft },
  warn: { fg: COLORS.warning, bg: COLORS.warningSoft },
  critical: { fg: COLORS.danger, bg: COLORS.dangerSoft },
  idle: { fg: COLORS.ink2, bg: COLORS.surface2 },
  accent: { fg: COLORS.accent, bg: COLORS.accentSoft },
};

/** Colour is never the only signal — the label always carries the meaning. */
export function Badge({ tone, label }: { tone: Tone; label: string }) {
  const { fg, bg } = TONES[tone];
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <View style={[styles.dot, { backgroundColor: fg }]} />
      <Text style={[styles.badgeText, { color: fg }]}>{label}</Text>
    </View>
  );
}

/**
 * A single number, made large enough to read at a glance.
 *
 * Replaces label-on-the-left/value-on-the-right rows for the figures the
 * driver actually checks — a row buries the number in a wall of same-size
 * text, which is exactly the thing they are scanning for.
 */
export function StatTile({
  label,
  value,
  caption,
  tone,
}: {
  label: string;
  value: string;
  caption?: string;
  tone?: Tone;
}) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, tone ? { color: TONES[tone].fg } : null]}>
        {value}
      </Text>
      {caption ? <Text style={styles.statCaption}>{caption}</Text> : null}
    </View>
  );
}

export function Row({
  label,
  value,
  mono,
  tone,
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: Tone;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text
        style={[
          styles.rowValue,
          mono ? { fontFamily: "monospace", fontSize: 13 } : null,
          tone ? { color: TONES[tone].fg } : null,
        ]}
      >
        {value}
      </Text>
    </View>
  );
}

export function Notice({
  tone = "warn",
  children,
}: {
  tone?: Tone;
  children: ReactNode;
}) {
  const { fg, bg } = TONES[tone];
  return (
    <View style={[styles.notice, { backgroundColor: bg }]}>
      <View style={[styles.noticeBar, { backgroundColor: fg }]} />
      <Text style={{ color: fg, fontSize: 13.5, lineHeight: 20, flex: 1 }}>
        {children}
      </Text>
    </View>
  );
}

/* --- Bottom navigation ---------------------------------------------------- */

export type TabKey = "duty" | "trips" | "diagnostics";

/**
 * Persistent bottom navigation.
 *
 * The previous build stacked "My trips" and "Diagnostics" as buttons at the
 * foot of a long scroll, so reaching them meant scrolling past everything
 * else and there was never any indication of where you were. A fixed bar is
 * both faster and orienting, and it sits in the thumb's arc.
 *
 * Icons are drawn from primitives rather than a font: the app ships no icon
 * set, and pulling one in for three glyphs is not worth the bundle.
 */
export function TabBar({
  active,
  onChange,
  badge,
}: {
  active: TabKey;
  onChange: (key: TabKey) => void;
  badge?: Partial<Record<TabKey, number>>;
}) {
  const tabs: { key: TabKey; label: string }[] = [
    { key: "duty", label: "Duty" },
    { key: "trips", label: "Trips" },
    { key: "diagnostics", label: "Status" },
  ];

  return (
    <View style={styles.tabBar}>
      {tabs.map((tab) => {
        const on = tab.key === active;
        const count = badge?.[tab.key] ?? 0;
        return (
          <Pressable
            key={tab.key}
            onPress={() => onChange(tab.key)}
            accessibilityRole="tab"
            accessibilityLabel={tab.label}
            accessibilityState={{ selected: on }}
            style={({ pressed }) => [
              styles.tab,
              { opacity: pressed ? 0.6 : 1 },
            ]}
          >
            <View>
              <TabGlyph tab={tab.key} active={on} />
              {count > 0 ? (
                <View style={styles.tabBadge}>
                  <Text style={styles.tabBadgeText}>{count > 9 ? "9+" : count}</Text>
                </View>
              ) : null}
            </View>
            <Text style={[styles.tabLabel, on && styles.tabLabelActive]}>
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function TabGlyph({ tab, active }: { tab: TabKey; active: boolean }) {
  const color = active ? COLORS.accent : COLORS.ink3;

  if (tab === "duty") {
    // A ring with a filled core — reads as a power/standby control.
    return (
      <View style={[glyph.box, { borderColor: color, borderWidth: 2, borderRadius: 11 }]}>
        <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: color }} />
      </View>
    );
  }

  if (tab === "trips") {
    // Two stops joined by a line — the route motif used on the trip cards.
    return (
      <View style={[glyph.box, { justifyContent: "space-between", paddingVertical: 2 }]}>
        <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: color }} />
        <View style={{ width: 2, flex: 1, backgroundColor: color, opacity: 0.45 }} />
        <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: color }} />
      </View>
    );
  }

  // Three ascending bars — a signal/health meter.
  return (
    <View style={[glyph.box, { flexDirection: "row", alignItems: "flex-end", gap: 3 }]}>
      {[7, 12, 17].map((h) => (
        <View
          key={h}
          style={{ width: 3.5, height: h, borderRadius: 2, backgroundColor: color }}
        />
      ))}
    </View>
  );
}

const glyph = StyleSheet.create({
  box: { width: 22, height: 22, alignItems: "center", justifyContent: "center" },
});

export const styles = StyleSheet.create({
  title: {
    fontSize: 30,
    fontWeight: "800",
    color: COLORS.ink,
    letterSpacing: -0.6,
    lineHeight: 34,
  },
  subtitle: { fontSize: 15, color: COLORS.ink2, lineHeight: 21 },
  sectionLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: COLORS.ink3,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    marginBottom: -4,
  },

  button: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 14,
    borderWidth: 1,
  },
  buttonLg: { paddingVertical: 19, borderRadius: 18 },
  buttonText: { fontSize: 15.5, fontWeight: "700", letterSpacing: -0.2 },
  buttonTextLg: { fontSize: 18 },

  card: {
    backgroundColor: COLORS.bg,
    borderRadius: 20,
    padding: 18,
    gap: 14,
  },

  label: { fontSize: 14, fontWeight: "600", color: COLORS.ink },
  input: {
    borderWidth: 1.5,
    borderColor: COLORS.stroke,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    color: COLORS.ink,
    backgroundColor: COLORS.bg,
  },
  hint: { fontSize: 13, color: COLORS.ink2 },

  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 999,
    alignSelf: "flex-start",
  },
  badgeText: { fontSize: 12.5, fontWeight: "700", letterSpacing: -0.1 },
  dot: { width: 7, height: 7, borderRadius: 4 },

  stat: {
    flex: 1,
    minWidth: 130,
    backgroundColor: COLORS.surface,
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 15,
    gap: 3,
  },
  statLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: COLORS.ink2,
    letterSpacing: 0.2,
  },
  statValue: {
    fontSize: 23,
    fontWeight: "800",
    color: COLORS.ink,
    letterSpacing: -0.7,
  },
  statCaption: { fontSize: 12, color: COLORS.ink3 },

  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 7,
    gap: 12,
  },
  rowLabel: { fontSize: 14, color: COLORS.ink2, flexShrink: 1 },
  rowValue: { fontSize: 14, color: COLORS.ink, fontWeight: "600" },

  notice: {
    flexDirection: "row",
    gap: 11,
    borderRadius: 14,
    padding: 14,
    alignItems: "flex-start",
  },
  noticeBar: { width: 3, borderRadius: 2, alignSelf: "stretch" },

  tabBar: {
    flexDirection: "row",
    backgroundColor: COLORS.bg,
    borderTopWidth: 1,
    borderTopColor: COLORS.stroke,
    paddingTop: 9,
    paddingBottom: 9,
    paddingHorizontal: 8,
  },
  tab: { flex: 1, alignItems: "center", gap: 5, paddingVertical: 2 },
  tabLabel: { fontSize: 11.5, fontWeight: "600", color: COLORS.ink3 },
  tabLabelActive: { color: COLORS.accent, fontWeight: "700" },
  tabBadge: {
    position: "absolute",
    top: -5,
    right: -10,
    minWidth: 17,
    height: 17,
    borderRadius: 9,
    paddingHorizontal: 4,
    backgroundColor: COLORS.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  tabBadgeText: { color: COLORS.white, fontSize: 10.5, fontWeight: "800" },
});
