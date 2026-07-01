import type { ProfileName } from "@codex-product-dogfood/schemas";

export interface JourneyStep {
  action: "open" | "click" | "fill" | "press" | "upload" | "observe";
  label: string;
  query?: string[];
  text?: string;
  key?: string;
  expectedSignals?: string[];
  failureSignals?: string[];
}

export interface AuditJourney {
  id: string;
  title: string;
  userGoal: string;
  steps: JourneyStep[];
}

export interface AuditProfile {
  name: ProfileName;
  description: string;
  testQuestion: string;
  primaryEntryKeywords: string[];
  expectedSignals: string[];
  failureSignals: string[];
  journeys: AuditJourney[];
}

const sharedFailureSignals = [
  "error",
  "failed",
  "exception",
  "unhandled",
  "network error",
  "加载失败",
  "出错",
  "异常",
  "失败"
];

export const profiles: Record<ProfileName, AuditProfile> = {
  "ai-chat": {
    name: "ai-chat",
    description: "A conversational AI product where users expect quick prompt entry, answer generation, upload, voice, and helpful empty/error states.",
    testQuestion: "Please explain photosynthesis in three bullet points and ask me one follow-up question.",
    primaryEntryKeywords: ["chat", "ask", "new", "start", "send", "开始", "提问", "聊天", "问"],
    expectedSignals: ["chatInput", "sendAction", "emptyState", "uploadAffordance", "voiceAffordance"],
    failureSignals: sharedFailureSignals,
    journeys: [
      {
        id: "first-prompt",
        title: "Ask the first question",
        userGoal: "A new user can find the input, ask a question, and see the product respond or clearly explain why it cannot.",
        steps: [
          { action: "open", label: "Open the target URL" },
          { action: "fill", label: "Enter a realistic first prompt", expectedSignals: ["chatInput"] },
          { action: "press", label: "Submit with Enter", key: "Enter", expectedSignals: ["sendAction"] },
          { action: "observe", label: "Look for answer, loading, empty, or error state" }
        ]
      },
      {
        id: "multimodal-entry",
        title: "Try multimodal controls",
        userGoal: "A user can discover upload and voice controls without hunting.",
        steps: [
          { action: "upload", label: "Try attaching a small file", expectedSignals: ["uploadAffordance"] },
          { action: "click", label: "Look for voice input", query: ["voice", "mic", "microphone", "语音", "麦克风"], expectedSignals: ["voiceAffordance"] }
        ]
      }
    ]
  },
  "student-learning": {
    name: "student-learning",
    description: "A student learning product where users expect learning entry points, practice input, formulas, upload, voice, clear empty states, and recoverable errors.",
    testQuestion: "Solve 2x + 5 = 17 step by step, then give me one similar practice problem.",
    primaryEntryKeywords: ["learn", "practice", "start", "question", "homework", "学习", "练习", "开始", "题目", "作业", "答疑"],
    expectedSignals: ["learningEntry", "chatInput", "formulaAffordance", "uploadAffordance", "voiceAffordance", "emptyState"],
    failureSignals: sharedFailureSignals,
    journeys: [
      {
        id: "start-learning",
        title: "Start a learning session",
        userGoal: "A student can find where to begin learning or ask for help.",
        steps: [
          { action: "open", label: "Open the target URL" },
          { action: "click", label: "Click the most likely learning entry", query: ["learn", "practice", "开始", "学习", "练习"], expectedSignals: ["learningEntry"] },
          { action: "fill", label: "Enter a math learning question", expectedSignals: ["chatInput", "formulaAffordance"] },
          { action: "press", label: "Submit with Enter", key: "Enter" }
        ]
      },
      {
        id: "homework-help",
        title: "Try homework help affordances",
        userGoal: "A student can attach homework, speak a question, or type formulas.",
        steps: [
          { action: "upload", label: "Try attaching homework evidence", expectedSignals: ["uploadAffordance"] },
          { action: "click", label: "Look for voice input", query: ["voice", "mic", "microphone", "语音", "麦克风"], expectedSignals: ["voiceAffordance"] },
          { action: "observe", label: "Check for empty, disabled, or error states" }
        ]
      }
    ]
  }
};

export function getProfile(name: string): AuditProfile {
  if (name !== "ai-chat" && name !== "student-learning") {
    throw new Error(`Unknown profile "${name}". Expected ai-chat or student-learning.`);
  }
  return profiles[name];
}

export function listProfiles(): ProfileName[] {
  return Object.keys(profiles) as ProfileName[];
}
