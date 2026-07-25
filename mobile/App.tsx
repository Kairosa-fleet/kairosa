import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  SafeAreaView,
  StatusBar as RNStatusBar,
  View,
} from "react-native";

import { TabBar, type TabKey } from "./src/components/ui";
import { COLORS } from "./src/lib/config";
import { isEnrolled, verifyEnrolment } from "./src/lib/api";
import { useTracking } from "./src/lib/useTracking";
import { DiagnosticsScreen } from "./src/screens/DiagnosticsScreen";
import { DutyScreen } from "./src/screens/DutyScreen";
import { TripsScreen } from "./src/screens/TripsScreen";
import { LoginScreen } from "./src/screens/LoginScreen";
import { PermissionScreen } from "./src/screens/PermissionScreen";

// Registers the background location task at module scope. This must happen
// before React renders, because Android can relaunch the app straight into
// the task with no UI — see src/lib/locationTask.ts.
import "./src/lib/locationTask";

export default function App() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [tab, setTab] = useState<TabKey>("duty");
  const tracking = useTracking();

  const refreshSession = useCallback(async () => {
    setSignedIn(await isEnrolled());
  }, []);

  useEffect(() => {
    // Check the token is still accepted, not merely present. A revoked device
    // or a driver who signed in on a newer handset must be sent back to the
    // sign-in screen rather than left on a duty screen that uploads nothing.
    void (async () => {
      if (!(await isEnrolled())) {
        setSignedIn(false);
        return;
      }
      const verdict = await verifyEnrolment();
      // "unknown" means the server was unreachable — stay signed in, because a
      // dead tunnel is not a revocation.
      setSignedIn(verdict !== "rejected");
    })();
  }, []);

  /* Sign-in and permissions are full-screen gates rather than tabs. Until both
     are satisfied nothing else in the app can do its job, and showing
     navigation would imply otherwise. Derived rather than stored, so a driver
     who revokes "Allow all the time" in Settings is returned to the permission
     screen instead of silently not reporting. */
  const gate =
    signedIn === null || !tracking.permissions
      ? "loading"
      : !signedIn
        ? "login"
        : !tracking.permissions.backgroundGranted
          ? "permissions"
          : null;

  // SafeAreaView only insets on iOS; on Android the content would slide under
  // the clock and battery icons, which is exactly where this screen puts the
  // driver's name.
  const topInset = Platform.OS === "android" ? (RNStatusBar.currentHeight ?? 0) : 0;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: COLORS.surface, paddingTop: topInset }}>
      <StatusBar style="dark" />

      {gate === "loading" ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator color={COLORS.accent} />
        </View>
      ) : gate === "login" ? (
        <LoginScreen onSignedIn={refreshSession} />
      ) : gate === "permissions" && tracking.permissions ? (
        <PermissionScreen
          status={tracking.permissions}
          onDone={() => void tracking.refresh()}
        />
      ) : (
        <>
          <View style={{ flex: 1 }}>
            {tab === "duty" ? (
              <DutyScreen tracking={tracking} />
            ) : tab === "trips" ? (
              <TripsScreen />
            ) : (
              <DiagnosticsScreen />
            )}
          </View>
          <TabBar
            active={tab}
            onChange={setTab}
            badge={{ duty: tracking.pending }}
          />
        </>
      )}
    </SafeAreaView>
  );
}
