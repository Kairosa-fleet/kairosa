import { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Text,
  View,
} from "react-native";

import { Button, Card, Field, Notice } from "../components/ui";
import { api } from "../lib/api";
import { COLORS } from "../lib/config";
import { readDeviceIdentity } from "../lib/deviceState";
import { logEvent } from "../lib/db";

/**
 * Driver sign-in.
 *
 * Identity belongs to the *driver*, not the handset. The earlier one-time
 * enrolment code bound it to the phone, which broke in all the ordinary ways —
 * a driver changes phone, borrows a colleague's, factory-resets — and every
 * one of those needed a dispatcher to mint a fresh code before the driver
 * could work.
 *
 * Signing in with an ID and password issued by the transport office fixes
 * that: the driver signs in anywhere, this handset is claimed for them, and
 * their already-booked trips follow them onto it.
 */
export function LoginScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");

  // Set only when the office-issued temporary password must be replaced.
  const [mustChange, setMustChange] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Claim this handset, then hand control back to the app shell. */
  async function claim(driverToken: string) {
    const identity = readDeviceIdentity();
    const device = await api.claimDevice(driverToken, {
      platform: identity.platform,
      model: identity.model,
      osVersion: identity.osVersion,
      appVersion: "1.0.0",
    });
    await logEvent("permission_changed", `signed in — ${device.label}`);
    onSignedIn();
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const session = await api.driverLogin(loginId.trim().toUpperCase(), password);
      if (session.mustChangePassword) {
        // Stop here rather than claiming the phone: the office knows this
        // password, so it is not yet a credential only the driver holds.
        setMustChange(true);
        return;
      }
      await claim(session.accessToken);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not sign in");
    } finally {
      setBusy(false);
    }
  }

  async function changePassword() {
    if (newPassword !== confirmPassword) {
      setError("The two passwords do not match");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const session = await api.driverSetPassword(
        loginId.trim().toUpperCase(),
        password,
        newPassword,
      );
      await claim(session.accessToken);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not set your password");
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={{ flex: 1 }}
    >
      <ScrollView
        contentContainerStyle={{ padding: 20, gap: 20, paddingTop: 60 }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ gap: 8 }}>
          <Text style={{ fontSize: 28, fontWeight: "700", color: COLORS.ink }}>
            {mustChange ? "Choose a password" : "Sign in"}
          </Text>
          <Text style={{ fontSize: 15, color: COLORS.ink2, lineHeight: 22 }}>
            {mustChange
              ? "Your transport office set a temporary password. Choose one only you know — you will use it every time you sign in."
              : "Use the driver ID and password your transport office gave you."}
          </Text>
        </View>

        {mustChange ? (
          <Card>
            <Field
              label="New password"
              placeholder="At least 8 characters"
              value={newPassword}
              onChangeText={setNewPassword}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Field
              label="Confirm password"
              placeholder="Type it again"
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
            />
            {error ? <Notice tone="critical">{error}</Notice> : null}
            <Button
              title="Save and continue"
              onPress={changePassword}
              loading={busy}
              disabled={newPassword.length < 8 || confirmPassword.length < 8}
            />
          </Card>
        ) : (
          <Card>
            <Field
              label="Driver ID"
              placeholder="DRV-0001"
              value={loginId}
              onChangeText={(t) => setLoginId(t.toUpperCase())}
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={20}
            />
            <Field
              label="Password"
              placeholder="Your password"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
            />
            {error ? <Notice tone="critical">{error}</Notice> : null}
            <Button
              title="Sign in"
              onPress={submit}
              loading={busy}
              disabled={loginId.trim().length < 3 || password.length < 1}
            />
          </Card>
        )}

        <Notice tone="idle">
          Tracking only runs while you are on duty. You control that with a
          switch on the next screen, and it is off until you turn it on.
        </Notice>

        {!mustChange ? (
          <Text style={{ fontSize: 13, color: COLORS.ink3, lineHeight: 20 }}>
            Forgotten your password? Your transport office can issue a new one
            from the dashboard.
          </Text>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
