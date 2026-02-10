import AsyncStorage from "@react-native-async-storage/async-storage";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

type ToolProfile = "cursor-ide" | "cursor-web" | "claude-code" | "generic";
type CategoryStatus = "success" | "failure" | "pending" | null;
type CheckCategory = "lint" | "type" | "test" | "e2e" | "other";

interface PRStatus {
  repo: string;
  number: number;
  branch?: string;
  title: string;
  failingChecks: number;
  unresolved: number;
  checks: Record<CheckCategory, CategoryStatus>;
  initiativePath?: string;
  initiativeName?: string;
  mergeable?: boolean | null;
}

interface InitiativeStatus {
  name: string;
  path: string;
  prs: PRStatus[];
}

interface StatusResponse {
  initiatives: InitiativeStatus[];
  updatedAt: string;
}

interface SettingsResponse {
  tool: ToolProfile;
  agentCommand: string | null;
}

interface ActionResponse {
  message?: string;
}

const API_URL_STORAGE_KEY = "order-up-mobile-api-url";
const DEFAULT_BASE_URL = normalizeBaseUrl(
  process.env.EXPO_PUBLIC_ORDER_UP_API_URL ?? "http://localhost:3333"
);
const TOOL_OPTIONS: ToolProfile[] = ["cursor-ide", "cursor-web", "claude-code", "generic"];
const CHECK_ORDER: CheckCategory[] = ["lint", "type", "test", "e2e", "other"];

function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (!trimmed) return "http://localhost:3333";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

function toDisplayName(initiativeName: string): string {
  return initiativeName === "\u2014" ? "Unassigned" : initiativeName;
}

function statusToken(status: CategoryStatus): string {
  if (status === "success") return "OK";
  if (status === "failure") return "FAIL";
  if (status === "pending") return "PEND";
  return "N/A";
}

function mergeabilityLabel(value: boolean | null | undefined): string {
  if (value === true) return "mergeable";
  if (value === false) return "conflicts";
  return "unknown";
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong.";
}

async function requestJson<T>(baseUrl: string, path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  const headers = new Headers(init.headers);
  if (init.body != null && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  try {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) {
      if (
        parsed &&
        typeof parsed === "object" &&
        "error" in parsed &&
        typeof (parsed as { error?: unknown }).error === "string"
      ) {
        throw new Error((parsed as { error: string }).error);
      }
      if (typeof parsed === "string" && parsed.trim()) {
        throw new Error(parsed);
      }
      throw new Error(`Request failed (${res.status})`);
    }
    return parsed as T;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Request timed out. Is Order Up running?");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export default function App() {
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [baseUrlInput, setBaseUrlInput] = useState(DEFAULT_BASE_URL);
  const [hasLoadedStoredUrl, setHasLoadedStoredUrl] = useState(false);
  const [statusData, setStatusData] = useState<StatusResponse | null>(null);
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const totalPRs = useMemo(
    () => statusData?.initiatives.reduce((acc, next) => acc + next.prs.length, 0) ?? 0,
    [statusData]
  );
  const failingPRs = useMemo(
    () =>
      statusData?.initiatives.reduce(
        (acc, next) => acc + next.prs.filter((pr) => pr.failingChecks > 0).length,
        0
      ) ?? 0,
    [statusData]
  );
  const commentPRs = useMemo(
    () =>
      statusData?.initiatives.reduce(
        (acc, next) => acc + next.prs.filter((pr) => pr.unresolved > 0).length,
        0
      ) ?? 0,
    [statusData]
  );

  const loadDashboard = useCallback(
    async (asRefresh = false) => {
      if (asRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);

      try {
        const [status, currentSettings] = await Promise.all([
          requestJson<StatusResponse>(baseUrl, "/api/status"),
          requestJson<SettingsResponse>(baseUrl, "/api/settings"),
        ]);
        setStatusData(status);
        setSettings(currentSettings);
      } catch (requestError) {
        setError(getErrorMessage(requestError));
      } finally {
        if (asRefresh) setRefreshing(false);
        else setLoading(false);
      }
    },
    [baseUrl]
  );

  useEffect(() => {
    let cancelled = false;

    async function loadStoredUrl(): Promise<void> {
      try {
        const stored = await AsyncStorage.getItem(API_URL_STORAGE_KEY);
        if (cancelled) return;
        if (stored && stored.trim()) {
          const normalized = normalizeBaseUrl(stored);
          setBaseUrl(normalized);
          setBaseUrlInput(normalized);
        }
      } catch {
        // ignore local storage failures and continue with default URL
      } finally {
        if (!cancelled) setHasLoadedStoredUrl(true);
      }
    }

    void loadStoredUrl();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hasLoadedStoredUrl) return;
    void loadDashboard();
  }, [hasLoadedStoredUrl, loadDashboard]);

  const saveBaseUrl = useCallback(async () => {
    const normalized = normalizeBaseUrl(baseUrlInput);
    try {
      await AsyncStorage.setItem(API_URL_STORAGE_KEY, normalized);
      setBaseUrl(normalized);
      setActionMessage(`Server target saved: ${normalized}`);
    } catch (storageError) {
      Alert.alert("Could not save URL", getErrorMessage(storageError));
    }
  }, [baseUrlInput]);

  const updateTool = useCallback(
    async (tool: ToolProfile) => {
      if (settings?.tool === tool) return;
      setBusyAction(`tool:${tool}`);
      try {
        const next = await requestJson<SettingsResponse>(baseUrl, "/api/settings", {
          method: "POST",
          body: JSON.stringify({ tool }),
        });
        setSettings(next);
        setActionMessage(`Tool set to ${tool}.`);
      } catch (requestError) {
        Alert.alert("Failed to update tool", getErrorMessage(requestError));
      } finally {
        setBusyAction(null);
      }
    },
    [baseUrl, settings?.tool]
  );

  const runFixAllIssues = useCallback(async () => {
    setBusyAction("fix-all");
    try {
      const result = await requestJson<ActionResponse>(baseUrl, "/api/fix-all-issues", {
        method: "POST",
      });
      setActionMessage(result.message ?? "Triggered fix-all issues.");
      await loadDashboard();
    } catch (requestError) {
      Alert.alert("Failed to trigger fix-all", getErrorMessage(requestError));
    } finally {
      setBusyAction(null);
    }
  }, [baseUrl, loadDashboard]);

  const runFinishPr = useCallback(
    async (pr: PRStatus) => {
      const actionKey = `finish:${pr.repo}#${pr.number}`;
      setBusyAction(actionKey);
      try {
        const result = await requestJson<ActionResponse>(baseUrl, "/api/finish-pr", {
          method: "POST",
          body: JSON.stringify({
            repo: pr.repo,
            number: pr.number,
            path: pr.initiativePath ?? undefined,
          }),
        });
        setActionMessage(result.message ?? `Started finish workflow for ${pr.repo}#${pr.number}.`);
        await loadDashboard();
      } catch (requestError) {
        Alert.alert("Failed to finish PR", getErrorMessage(requestError));
      } finally {
        setBusyAction(null);
      }
    },
    [baseUrl, loadDashboard]
  );

  const runFixCheck = useCallback(
    async (pr: PRStatus, check: CheckCategory) => {
      const actionKey = `check:${pr.repo}#${pr.number}:${check}`;
      setBusyAction(actionKey);
      try {
        const result = await requestJson<ActionResponse>(baseUrl, "/api/fix-check", {
          method: "POST",
          body: JSON.stringify({
            repo: pr.repo,
            number: pr.number,
            check,
            path: pr.initiativePath ?? undefined,
          }),
        });
        setActionMessage(
          result.message ?? `Started ${check} fix for ${pr.repo}#${pr.number}.`
        );
      } catch (requestError) {
        Alert.alert(`Failed to fix ${check}`, getErrorMessage(requestError));
      } finally {
        setBusyAction(null);
      }
    },
    [baseUrl]
  );

  const confirmAndFixAll = useCallback(() => {
    Alert.alert(
      "Fix all issues?",
      "This triggers background agents/prompts for all tracked PR issues.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Run", style: "default", onPress: () => void runFixAllIssues() },
      ]
    );
  }, [runFixAllIssues]);

  const showLocalhostHint = /localhost|127\.0\.0\.1/.test(baseUrl);

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <StatusBar style="light" />
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => void loadDashboard(true)} />
        }
      >
        <Text style={styles.title}>Order Up Mobile</Text>
        <Text style={styles.subtitle}>
          Native dashboard for monitoring PR health and triggering fixes from your phone.
        </Text>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Server URL</Text>
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            value={baseUrlInput}
            onChangeText={setBaseUrlInput}
            placeholder="http://192.168.1.10:3333"
            placeholderTextColor="#94a3b8"
            style={styles.urlInput}
          />
          <View style={styles.row}>
            <Pressable style={styles.primaryButton} onPress={() => void saveBaseUrl()}>
              <Text style={styles.primaryButtonText}>Save URL</Text>
            </Pressable>
            <Pressable style={styles.secondaryButton} onPress={() => void loadDashboard()}>
              <Text style={styles.secondaryButtonText}>Refresh now</Text>
            </Pressable>
          </View>
          {showLocalhostHint ? (
            <Text style={styles.hintText}>
              Tip: for a physical phone, use your computer's LAN IP (not localhost).
            </Text>
          ) : null}
          <Text style={styles.inlineMeta}>Active: {baseUrl}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Tool profile</Text>
          <View style={styles.pillWrap}>
            {TOOL_OPTIONS.map((tool) => {
              const selected = settings?.tool === tool;
              const disabled = busyAction?.startsWith("tool:");
              return (
                <Pressable
                  key={tool}
                  onPress={() => void updateTool(tool)}
                  disabled={disabled}
                  style={[styles.pill, selected ? styles.pillActive : styles.pillIdle]}
                >
                  <Text style={[styles.pillText, selected ? styles.pillTextActive : styles.pillTextIdle]}>
                    {tool}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View style={styles.summaryRow}>
          <View style={styles.summaryCard}>
            <Text style={styles.summaryValue}>{statusData?.initiatives.length ?? 0}</Text>
            <Text style={styles.summaryLabel}>Initiatives</Text>
          </View>
          <View style={styles.summaryCard}>
            <Text style={styles.summaryValue}>{totalPRs}</Text>
            <Text style={styles.summaryLabel}>Open PRs</Text>
          </View>
          <View style={styles.summaryCard}>
            <Text style={styles.summaryValue}>{failingPRs}</Text>
            <Text style={styles.summaryLabel}>With failures</Text>
          </View>
          <View style={styles.summaryCard}>
            <Text style={styles.summaryValue}>{commentPRs}</Text>
            <Text style={styles.summaryLabel}>With comments</Text>
          </View>
        </View>

        <Pressable
          style={[styles.fullWidthAction, busyAction === "fix-all" ? styles.disabledButton : null]}
          disabled={busyAction === "fix-all"}
          onPress={confirmAndFixAll}
        >
          <Text style={styles.fullWidthActionText}>Fix all issues</Text>
        </Pressable>

        {loading ? (
          <View style={styles.loadingWrap}>
            <ActivityIndicator color="#60a5fa" />
            <Text style={styles.loadingText}>Loading dashboard...</Text>
          </View>
        ) : null}

        {error ? <Text style={styles.errorText}>Error: {error}</Text> : null}
        {actionMessage ? <Text style={styles.successText}>{actionMessage}</Text> : null}

        {statusData?.initiatives.map((initiative) => (
          <View key={`${initiative.name}-${initiative.path}`} style={styles.card}>
            <Text style={styles.cardTitle}>
              {toDisplayName(initiative.name)} ({initiative.prs.length})
            </Text>

            {initiative.prs.map((pr) => {
              const failedChecks = CHECK_ORDER.filter((check) => pr.checks[check] === "failure");
              const finishActionKey = `finish:${pr.repo}#${pr.number}`;
              const finishBusy = busyAction === finishActionKey;

              return (
                <View key={`${pr.repo}#${pr.number}`} style={styles.prCard}>
                  <Text style={styles.prTitle}>
                    {pr.repo} #{pr.number}
                  </Text>
                  <Text style={styles.prSubtitle}>{pr.title}</Text>
                  <Text style={styles.inlineMeta}>
                    checks: {pr.failingChecks} | unresolved comments: {pr.unresolved} | merge:{" "}
                    {mergeabilityLabel(pr.mergeable)}
                  </Text>

                  <View style={styles.checkGrid}>
                    {CHECK_ORDER.map((check) => (
                      <View key={check} style={styles.checkPill}>
                        <Text style={styles.checkName}>{check}</Text>
                        <Text style={styles.checkValue}>{statusToken(pr.checks[check])}</Text>
                      </View>
                    ))}
                  </View>

                  {failedChecks.length > 0 ? (
                    <View style={styles.failedCheckButtonRow}>
                      {failedChecks.map((check) => {
                        const actionKey = `check:${pr.repo}#${pr.number}:${check}`;
                        return (
                          <Pressable
                            key={check}
                            style={[styles.ghostButton, busyAction === actionKey ? styles.disabledButton : null]}
                            onPress={() => void runFixCheck(pr, check)}
                            disabled={busyAction === actionKey}
                          >
                            <Text style={styles.ghostButtonText}>Fix {check}</Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  ) : null}

                  <Pressable
                    style={[styles.primaryButton, finishBusy ? styles.disabledButton : null]}
                    onPress={() => void runFinishPr(pr)}
                    disabled={finishBusy}
                  >
                    <Text style={styles.primaryButtonText}>Finish PR</Text>
                  </Pressable>
                </View>
              );
            })}
          </View>
        ))}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#020617",
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 44,
    gap: 12,
  },
  title: {
    color: "#f8fafc",
    fontSize: 30,
    fontWeight: "800",
  },
  subtitle: {
    color: "#cbd5e1",
    fontSize: 14,
    lineHeight: 20,
  },
  card: {
    backgroundColor: "#0f172a",
    borderColor: "#1e293b",
    borderWidth: 1,
    borderRadius: 16,
    padding: 14,
    gap: 10,
  },
  cardTitle: {
    color: "#f8fafc",
    fontSize: 18,
    fontWeight: "700",
  },
  urlInput: {
    backgroundColor: "#1e293b",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#334155",
    color: "#f8fafc",
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  row: {
    flexDirection: "row",
    gap: 10,
  },
  primaryButton: {
    backgroundColor: "#2563eb",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryButtonText: {
    color: "#ffffff",
    fontWeight: "700",
    fontSize: 14,
  },
  secondaryButton: {
    backgroundColor: "#1d4ed8",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryButtonText: {
    color: "#dbeafe",
    fontWeight: "700",
    fontSize: 14,
  },
  hintText: {
    color: "#fbbf24",
    fontSize: 12,
  },
  inlineMeta: {
    color: "#94a3b8",
    fontSize: 12,
  },
  pillWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  pill: {
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  pillActive: {
    borderColor: "#22d3ee",
    backgroundColor: "#164e63",
  },
  pillIdle: {
    borderColor: "#334155",
    backgroundColor: "#1e293b",
  },
  pillText: {
    fontSize: 12,
    fontWeight: "700",
  },
  pillTextActive: {
    color: "#cffafe",
  },
  pillTextIdle: {
    color: "#cbd5e1",
  },
  summaryRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  summaryCard: {
    flexGrow: 1,
    minWidth: "22%",
    backgroundColor: "#0f172a",
    borderColor: "#1e293b",
    borderWidth: 1,
    borderRadius: 12,
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: 8,
    gap: 2,
  },
  summaryValue: {
    color: "#e2e8f0",
    fontSize: 18,
    fontWeight: "800",
  },
  summaryLabel: {
    color: "#94a3b8",
    fontSize: 11,
  },
  fullWidthAction: {
    backgroundColor: "#7c3aed",
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#8b5cf6",
  },
  fullWidthActionText: {
    color: "#f5f3ff",
    fontWeight: "800",
    fontSize: 14,
  },
  loadingWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  loadingText: {
    color: "#cbd5e1",
    fontSize: 13,
  },
  errorText: {
    color: "#fca5a5",
    fontSize: 13,
  },
  successText: {
    color: "#86efac",
    fontSize: 13,
  },
  prCard: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#334155",
    backgroundColor: "#020617",
    padding: 12,
    gap: 8,
  },
  prTitle: {
    color: "#e2e8f0",
    fontSize: 15,
    fontWeight: "700",
  },
  prSubtitle: {
    color: "#cbd5e1",
    fontSize: 13,
  },
  checkGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  checkPill: {
    minWidth: 64,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#334155",
    backgroundColor: "#0f172a",
    paddingHorizontal: 8,
    paddingVertical: 5,
    gap: 2,
  },
  checkName: {
    color: "#94a3b8",
    fontSize: 11,
    textTransform: "uppercase",
  },
  checkValue: {
    color: "#e2e8f0",
    fontSize: 12,
    fontWeight: "700",
  },
  failedCheckButtonRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  ghostButton: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#475569",
    backgroundColor: "#1e293b",
    paddingHorizontal: 9,
    paddingVertical: 6,
  },
  ghostButtonText: {
    color: "#cbd5e1",
    fontSize: 12,
    fontWeight: "600",
  },
  disabledButton: {
    opacity: 0.5,
  },
});
