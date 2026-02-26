/**
 * ================================================
 * InteractiveAvatar.tsx - 미디어커뮤니케이션학 전공 AI 상담사
 * ================================================
 *
 * 기능:
 * 1. 음성 질문 → Web Speech API → OpenAI → REPEAT 발화
 * 2. 텍스트 질문 → OpenAI → REPEAT 발화
 * 3. 랜딩페이지 빠른 질문 버튼 → postMessage → 아바타 답변
 * 4. 로그인 사용자 정보 수신 → ★ 개인화 인사말 (재방문 이력 기반)
 * 5. 대화 내용 DB 저장 (save_chat API)
 *
 * 핵심: 아바타가 말할 때 Web Speech 일시정지 → 자기 목소리 인식 방지
 * ================================================
 */

import {
  AvatarQuality,
  ElevenLabsModel,
  StreamingEvents,
  VoiceEmotion,
  StartAvatarRequest,
  TaskType,
} from "@heygen/streaming-avatar";
import { useEffect, useRef, useState, useCallback } from "react";
import { useMemoizedFn, useUnmount } from "ahooks";

import { useStreamingAvatarSession } from "./logic/useStreamingAvatarSession";
import { StreamingAvatarProvider, StreamingAvatarSessionState } from "./logic";
import { AVATARS } from "@/app/lib/constants";
import { WebSpeechRecognizer } from "@/app/lib/webSpeechAPI";

// 아바타 설정 - Wayne 아바타 + ElevenLabs 한국어 음성
const AVATAR_CONFIG: StartAvatarRequest = {
  quality: AvatarQuality.Medium,
  avatarName: "bbf5d8ffc23a43e085cb8b2823dbe7fa",
  language: "ko",
};

// ============================================
// DB 저장 API 설정
// ============================================
const API_BASE = "https://aiforalab.com/mediacom-api/api.php";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

// DB에 대화 저장하는 함수
async function saveChatToDB(
  userMessage: string,
  botResponse: string,
  sessionId: string
) {
  try {
    // localStorage에서 토큰 가져오기 (부모 창에서 전달받은 정보 사용)
    const token =
      (window as any).__mediacom_token ||
      "";

    if (!token) {
      console.log("⚠️ 토큰 없음 - 대화 저장 생략 (게스트)");
      return;
    }

    const response = await fetch(API_BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "save_chat",
        token: token,
        user_message: userMessage,
        bot_response: botResponse,
        session_id: sessionId,
        context: "avatar_bot",
      }),
    });

    const data = await response.json();
    if (data.success) {
      console.log("💾 대화 DB 저장 완료");
    } else {
      console.warn("⚠️ 대화 저장 실패:", data.error);
    }
  } catch (error) {
    console.error("❌ 대화 저장 에러:", error);
  }
}

// ============================================
// ★ 개인화 인사말 생성 함수
// ============================================
function generateGreeting(userInfo: any): string {
  const name = userInfo?.name || '';
  const history = userInfo?.history;

  // 이력 정보가 없거나 첫 방문인 경우
  if (!history || history.visit_count <= 1) {
    if (name) {
      return `안녕하세요, ${name}님! 차 의과학 대학교, Midia Communication학 전공 에이 아이 상담사, 김정환 교수입니다. ${name}님의 방문을 환영합니다! 전공에 대해 궁금한 게 있으면, 편하게 물어보세요!`;
    }
    return `안녕하세요! 차 의과학 대학교, Midia Communication학 전공 에이 아이 상담사, 김정환 교수입니다. 전공에 대해 궁금한 게 있으면, 편하게 물어보세요!`;
  }

  // 재방문인 경우 — 개인화 인사말
  const visitCount = history.visit_count;
  const topics = history.recent_topics || [];

  // 토픽 한국어 매핑
  const topicNames: Record<string, string> = {
    '커리큘럼': '커리큘럼',
    '교수진': '교수진',
    '진로': '진로와 취업',
    '활동': '학생 활동',
    '입학': '입학 정보',
    '트랙': '세부 트랙',
    '전공소개': '전공 소개',
  };

  // 토픽 문자열 생성
  let topicStr = '';
  if (topics.length === 1) {
    topicStr = topicNames[topics[0]] || topics[0];
  } else if (topics.length === 2) {
    topicStr = `${topicNames[topics[0]] || topics[0]}과, ${topicNames[topics[1]] || topics[1]}`;
  } else if (topics.length >= 3) {
    topicStr = `${topicNames[topics[0]] || topics[0]}, ${topicNames[topics[1]] || topics[1]} 등`;
  }

  // 방문 횟수를 한글로
  const visitKorean = ['', '', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉', '열'];
  const visitWord = visitCount <= 10
    ? `${visitKorean[visitCount]}번째`
    : `${visitCount}번째`;

  // 인사말 조합
  if (topicStr) {
    return `${name}님, ${visitWord} 방문을 환영합니다! 지난번에는, ${topicStr}에 대해 물어보셨는데, 오늘은 어떤 부분이 궁금하세요?`;
  }

  return `${name}님, ${visitWord} 방문을 환영합니다! 오늘은 어떤 것이 궁금하세요?`;
}

function InteractiveAvatar() {
  const {
    initAvatar,
    startAvatar,
    stopAvatar,
    sessionState,
    stream,
    avatarRef,
  } = useStreamingAvatarSession();

  // UI 상태
  const [inputText, setInputText] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [isListening, setIsListening] = useState(false);
  const [isAvatarSpeaking, setIsAvatarSpeaking] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState("");
  const mediaStream = useRef<HTMLVideoElement>(null);

  // 내부 상태 refs
  const isProcessingRef = useRef(false);
  const hasGreetedRef = useRef(false);
  const hasStartedRef = useRef(false);

  // Web Speech API ref
  const webSpeechRef = useRef<WebSpeechRecognizer | null>(null);
  const isAvatarSpeakingRef = useRef(false);
  const micStreamRef = useRef<MediaStream | null>(null);

  // 로그인 사용자 정보 ref (★ history 포함)
  const userInfoRef = useRef<any>(null);

  // 세션 ID (대화 묶음 식별용)
  const sessionIdRef = useRef<string>(
    `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  );

  // ============================================
  // API 호출
  // ============================================
  const fetchAccessToken = async () => {
    const response = await fetch("/api/get-access-token", { method: "POST" });
    const token = await response.text();
    console.log("Access Token:", token);
    return token;
  };

  // 💬 채팅 API 호출 (OpenAI)
  const callOpenAI = async (message: string, history: ChatMessage[]) => {
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: message,
          history: history,
        }),
      });
      const data = await response.json();
      console.log("📦 API raw response:", data);
      return data;
    } catch (error) {
      console.error("OpenAI API error:", error);
      return { reply: "죄송합니다. 일시적인 오류가 발생했습니다. 다시 말씀해 주세요.", action: "none", tabId: null };
    }
  };

  // ============================================
  // 아바타 음성 출력 (Web Speech 일시정지 포함)
  // ============================================
  const speakWithAvatar = useCallback(
    async (text: string) => {
      if (!avatarRef.current || !text) return;

      try {
        // 🔇 Web Speech 완전히 정지
        console.log("🔇 Web Speech 일시정지");
        isAvatarSpeakingRef.current = true;
        setIsAvatarSpeaking(true);
        webSpeechRef.current?.pause();

        // 잠시 대기 (Web Speech가 완전히 멈출 때까지)
        await new Promise((r) => setTimeout(r, 300));

        // HeyGen 자동 응답 차단
        try {
          await avatarRef.current.interrupt();
        } catch {
          // ignore
        }

        console.log("🗣️ Avatar speaking:", text);
        await avatarRef.current.speak({
          text,
          taskType: TaskType.REPEAT,
        });
      } catch (error) {
        console.error("Avatar speak error:", error);
        isAvatarSpeakingRef.current = false;
        setIsAvatarSpeaking(false);
        webSpeechRef.current?.resume();
      }
    },
    [avatarRef],
  );

  // ============================================
  // 🎤 사용자 음성 처리 (Web Speech API용)
  // ============================================
  const handleUserSpeech = useCallback(
    async (transcript: string) => {
      if (isAvatarSpeakingRef.current) {
        console.log("⏸️ 아바타가 말하는 중 - 무시:", transcript);
        return;
      }

      if (!transcript.trim() || isProcessingRef.current) return;

      isProcessingRef.current = true;
      setIsLoading(true);
      setInterimTranscript("");
      console.log("🎯 User said:", transcript);

      setChatHistory((prev) => {
        const newHistory = [
          ...prev,
          { role: "user" as const, content: transcript },
        ];

        callOpenAI(transcript, prev).then(async (response) => {
          console.log("🎯 OpenAI response:", response);

          const reply = response.reply || response;

          setChatHistory((current) => [
            ...current,
            { role: "assistant" as const, content: reply },
          ]);

          // 랜딩페이지 자동 스크롤 요청
          if (response.action === "scroll" && response.tabId) {
            window.parent.postMessage(
              { type: "SCROLL_TO", sectionId: response.tabId },
              "*",
            );
          }

          // ✅ 대화 내용 DB에 저장
          saveChatToDB(transcript, reply, sessionIdRef.current);

          // 랜딩페이지에도 대화 저장 알림 (체류시간 추적용)
          window.parent.postMessage(
            {
              type: "CHAT_SAVED",
              user_message: transcript,
              bot_response: reply,
            },
            "*",
          );

          // 아바타 발화
          await speakWithAvatar(reply);

          setIsLoading(false);
          isProcessingRef.current = false;
        });

        return newHistory;
      });
    },
    [speakWithAvatar],
  );

  // ============================================
  // Web Speech API 초기화
  // ============================================
  const initWebSpeech = useCallback(() => {
    if (webSpeechRef.current) {
      console.log("🎤 Web Speech 이미 초기화됨");
      return;
    }

    if (!WebSpeechRecognizer.isSupported()) {
      console.error("🎤 Web Speech API 지원하지 않는 브라우저");
      alert(
        "이 브라우저는 음성 인식을 지원하지 않습니다. Chrome 또는 Edge를 사용해주세요.",
      );
      return;
    }

    console.log("🎤 Web Speech API 초기화 중...");

    webSpeechRef.current = new WebSpeechRecognizer(
      {
        onResult: (transcript: string, isFinal: boolean) => {
          if (isAvatarSpeakingRef.current) {
            return;
          }

          if (isFinal) {
            console.log("🎤 최종 인식:", transcript);
            setInterimTranscript("");
            handleUserSpeech(transcript);
          } else {
            setInterimTranscript(transcript);
          }
        },

        onStart: () => {
          if (!isAvatarSpeakingRef.current) {
            setIsListening(true);
          }
        },

        onEnd: () => {
          setIsListening(false);
        },

        onSpeechStart: () => {
          if (!isAvatarSpeakingRef.current) {
            setIsListening(true);
          }
        },

        onSpeechEnd: () => {
          setTimeout(() => {
            if (!isAvatarSpeakingRef.current) {
              setIsListening(false);
            }
          }, 500);
        },

        onError: (error: string) => {
          console.error("🎤 Web Speech 에러:", error);
          if (error === "not-allowed") {
            alert(
              "마이크 권한이 필요합니다. 브라우저 설정에서 마이크를 허용해주세요.",
            );
          }
        },
      },
      {
        lang: "ko-KR",
        continuous: true,
        interimResults: true,
        autoRestart: true,
      },
    );

    console.log("🎤 Web Speech API 초기화 완료");
  }, [handleUserSpeech]);

  // ============================================
  // 세션 초기화
  // ============================================
  const resetSession = useMemoizedFn(async () => {
    console.log("🔄 세션 초기화 중...");

    // Web Speech 정리
    if (webSpeechRef.current) {
      webSpeechRef.current.destroy();
      webSpeechRef.current = null;
    }

    // 마이크 스트림 정리
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(track => track.stop());
      micStreamRef.current = null;
    }

    // HeyGen 세션 정리
    try {
      if (avatarRef.current) {
        await avatarRef.current.stopAvatar();
      }
    } catch (e) {
      console.log("stopAvatar 에러 (무시):", e);
    }

    try {
      await stopAvatar();
    } catch (e) {
      console.log("stopAvatar hook 에러 (무시):", e);
    }

    // 상태 초기화
    hasStartedRef.current = false;
    hasGreetedRef.current = false;
    isProcessingRef.current = false;
    isAvatarSpeakingRef.current = false;
    setChatHistory([]);
    setIsLoading(false);
    setIsListening(false);
    setIsAvatarSpeaking(false);
    setInterimTranscript("");

    // 새 세션 ID 생성
    sessionIdRef.current = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    await new Promise((r) => setTimeout(r, 1000));
    console.log("🔄 세션 초기화 완료");
  });

  // ============================================
  // 세션 시작
  // ============================================
  const startSession = useMemoizedFn(async () => {
    if (hasStartedRef.current) {
      console.log("⚠️ 이미 세션 시작됨, 무시");
      return;
    }
    hasStartedRef.current = true;

    try {
      // 🎤 마이크 권한을 미리 확보 (이후 Web Speech API 재시작 시 권한 팝업 방지)
      try {
        micStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
        console.log("🎤 마이크 권한 확보 완료");
      } catch (micError) {
        console.error("🎤 마이크 권한 거부:", micError);
      }

      const token = await fetchAccessToken();
      const avatar = initAvatar(token);

      avatar.on(StreamingEvents.STREAM_READY, async (event) => {
        console.log("Stream ready:", event.detail);

        // ★ 변경: USER_INFO가 이미 있으면 즉시 개인화 인사, 없으면 대기
        if (!hasGreetedRef.current) {
          await new Promise((r) => setTimeout(r, 1500));

          if (userInfoRef.current) {
            // USER_INFO가 이미 도착한 경우 → 개인화 인사말
            const greeting = generateGreeting(userInfoRef.current);
            console.log("👋 개인화 인사말:", greeting);
            await speakWithAvatar(greeting);
            setChatHistory([{ role: "assistant", content: greeting }]);
            hasGreetedRef.current = true;
          } else {
            // USER_INFO 대기 (3초 후 기본 인사말)
            console.log("⏳ USER_INFO 대기 중... (3초 타임아웃)");
            setTimeout(async () => {
              if (!hasGreetedRef.current) {
                const greeting = "안녕하세요! 차 의과학 대학교, Midia Communication학 전공 에이 아이 상담사, 김정환 교수입니다. 전공에 대해 궁금한 게 있으면, 편하게 물어보세요!";
                console.log("👋 기본 인사말 (타임아웃):", greeting);
                await speakWithAvatar(greeting);
                setChatHistory([{ role: "assistant", content: greeting }]);
                hasGreetedRef.current = true;
              }
            }, 3000);
          }
        }
      });

      avatar.on(StreamingEvents.STREAM_DISCONNECTED, () => {
        console.log("Stream disconnected");
        hasGreetedRef.current = false;
        hasStartedRef.current = false;

        webSpeechRef.current?.destroy();
        webSpeechRef.current = null;
      });

      avatar.on(StreamingEvents.AVATAR_START_TALKING, () => {
        console.log("🗣️ Avatar started talking - Web Speech 일시정지");
        isAvatarSpeakingRef.current = true;
        setIsAvatarSpeaking(true);
        webSpeechRef.current?.pause();
      });

      avatar.on(StreamingEvents.AVATAR_STOP_TALKING, async () => {
        console.log("🔈 Avatar stopped talking - Web Speech 재개");
        isAvatarSpeakingRef.current = false;
        setIsAvatarSpeaking(false);

        await new Promise((r) => setTimeout(r, 500));
        webSpeechRef.current?.resume();
        console.log("🎤 Web Speech 재개 완료");
      });

      await startAvatar(AVATAR_CONFIG);

      console.log("🎤 Web Speech API 시작...");
      initWebSpeech();

      setTimeout(() => {
        webSpeechRef.current?.start();
        console.log("🎤 Web Speech 인식 시작");
      }, 2000);
    } catch (error) {
      console.error("Session error:", error);
      hasStartedRef.current = false;
    }
  });

  // ============================================
  // 텍스트 메시지 전송
  // ============================================
  const handleSendMessage = useMemoizedFn(async () => {
    const text = inputText.trim();
    if (!text || !avatarRef.current || isLoading) return;

    setInputText("");
    setIsLoading(true);

    const newHistory = [
      ...chatHistory,
      { role: "user" as const, content: text },
    ];

    setChatHistory(newHistory);

    const response = await callOpenAI(text, chatHistory);

    const reply = response.reply || response;

    setChatHistory([
      ...newHistory,
      { role: "assistant" as const, content: reply },
    ]);

    // 랜딩페이지 자동 스크롤 요청
    if (response.action === "scroll" && response.tabId) {
      window.parent.postMessage(
        { type: "SCROLL_TO", sectionId: response.tabId },
        "*",
      );
    }

    // ✅ 대화 내용 DB에 저장
    saveChatToDB(text, reply, sessionIdRef.current);

    await speakWithAvatar(reply);

    setIsLoading(false);
  });

  // ============================================
  // 마이크 토글 버튼 핸들러
  // ============================================
  const toggleMicrophone = useCallback(() => {
    if (!webSpeechRef.current) {
      initWebSpeech();
      setTimeout(() => {
        webSpeechRef.current?.start();
      }, 100);
      return;
    }

    if (webSpeechRef.current.getIsPaused()) {
      webSpeechRef.current.resume();
    } else {
      webSpeechRef.current.pause();
    }
  }, [initWebSpeech]);

  // ============================================
  // postMessage 통신 (랜딩페이지와)
  // ============================================
  useEffect(() => {
    const handleMessage = async (event: MessageEvent) => {
      // origin 검증 (보안)
      const allowedOrigins = [
        "https://sungbongju.github.io",
        "http://localhost",
        "http://127.0.0.1",
      ];

      const isAllowed = allowedOrigins.some((origin) =>
        event.origin.startsWith(origin)
      );

      if (!isAllowed) {
        console.log("⚠️ Ignored message from:", event.origin);
        return;
      }

      const { type, question } = event.data || {};
      console.log("📥 Received message:", { type, question, origin: event.origin });

      // ★ 로그인된 사용자 정보 + 이력 수신
      if (type === "USER_INFO" && event.data.user) {
        // userInfoRef에 user 정보 + history 함께 저장
        userInfoRef.current = {
          name: event.data.user.name,
          student_id: event.data.user.student_id,
          history: event.data.history || null,
        };

        // 토큰도 저장 (대화 DB 저장에 사용)
        if (event.data.token) {
          (window as any).__mediacom_token = event.data.token;
        }
        console.log("👤 사용자 정보 + 이력 수신:", event.data.user.name, event.data.history);

        // ★ 아바타가 이미 준비됐지만 아직 인사 안 한 경우 → 즉시 개인화 인사
        if (avatarRef.current && hasGreetedRef.current === false && hasStartedRef.current) {
          const greeting = generateGreeting(userInfoRef.current);
          console.log("👋 개인화 인사말 (USER_INFO 도착 후):", greeting);
          await speakWithAvatar(greeting);
          setChatHistory([{ role: "assistant", content: greeting }]);
          hasGreetedRef.current = true;
        }
      }

      // 랜딩페이지 빠른 질문 버튼에서 전달된 질문
      if (type === "ASK_QUESTION" && question) {
        handleUserSpeech(question);
      }

      // 아바타 시작 신호
      if (type === "START_AVATAR") {
        if (!hasStartedRef.current) {
          startSession();
        }
      }
    };

    window.addEventListener("message", handleMessage);

    // 콘솔 테스트용: window.ask("질문")
    (window as unknown as Record<string, unknown>).ask = (q: string) => {
      handleUserSpeech(q);
    };

    return () => window.removeEventListener("message", handleMessage);
  }, [handleUserSpeech, startSession]);

  // 언마운트 시 정리
  useUnmount(() => {
    webSpeechRef.current?.destroy();
    micStreamRef.current?.getTracks().forEach(track => track.stop());
    micStreamRef.current = null;

    try {
      stopAvatar();
    } catch {
      // ignore
    }
  });

  // ============================================
  // 페이지 새로고침/닫기 전 세션 정리
  // ============================================
  useEffect(() => {
    const handleBeforeUnload = () => {
      console.log("🔄 beforeunload - 세션 정리 중...");

      if (webSpeechRef.current) {
        webSpeechRef.current.destroy();
        webSpeechRef.current = null;
      }

      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach(track => track.stop());
        micStreamRef.current = null;
      }

      if (avatarRef.current) {
        try {
          avatarRef.current.stopAvatar();
        } catch {
          // ignore
        }
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [avatarRef]);

  // 비디오 스트림 연결
  useEffect(() => {
    if (stream && mediaStream.current) {
      mediaStream.current.srcObject = stream;
      mediaStream.current.onloadedmetadata = () => mediaStream.current?.play();
    }
  }, [stream]);

  // ============================================
  // UI
  // ============================================
  const getStatusText = () => {
    if (isAvatarSpeaking) return "답변 중...";
    if (isListening) return "듣는 중...";
    if (isLoading) return "생각 중...";
    return "말씀하세요";
  };

  const getStatusColor = () => {
    if (isAvatarSpeaking) return "bg-blue-500";
    if (isListening) return "bg-red-500 animate-pulse";
    if (isLoading) return "bg-yellow-500";
    return "bg-green-500";
  };

  return (
    <div className="w-full h-full flex flex-col">
      {sessionState === StreamingAvatarSessionState.CONNECTED && stream ? (
        <div className="flex-1 relative">
          <div className="relative w-full h-full">
            <video
              ref={mediaStream}
              autoPlay
              playsInline
              style={{ display: "block", width: "100%", height: "100%", objectFit: "cover" }}
            />

            {/* 종료 버튼 */}
            <button
              className="absolute top-2 right-2 w-7 h-7 bg-black/50 hover:bg-red-600 text-white rounded-full flex items-center justify-center text-xs"
              onClick={() => resetSession()}
            >
              ✕
            </button>

            {/* 마이크 토글 버튼 */}
            <button
              className={`absolute top-2 left-2 w-7 h-7 ${
                isListening
                  ? "bg-red-500 animate-pulse"
                  : "bg-black/50 hover:bg-green-600"
              } text-white rounded-full flex items-center justify-center text-sm`}
              disabled={isAvatarSpeaking}
              title={isListening ? "마이크 끄기" : "마이크 켜기"}
              onClick={toggleMicrophone}
            >
              {isListening ? "🎤" : "🎙️"}
            </button>

            {/* 상태 표시 */}
            <div className="absolute bottom-2 left-2 flex items-center gap-2">
              <div className={`w-3 h-3 rounded-full ${getStatusColor()}`} />
              <span className="text-white text-xs bg-black/50 px-2 py-1 rounded">
                {getStatusText()}
              </span>
            </div>

            {/* 중간 인식 결과 표시 */}
            {interimTranscript && (
              <div className="absolute bottom-10 left-2 right-2">
                <div className="bg-black/70 text-white text-xs px-2 py-1 rounded">
                  🎤 &quot;{interimTranscript}&quot;
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-zinc-900 via-zinc-800 to-zinc-900">
          {sessionState === StreamingAvatarSessionState.CONNECTING ? (
            <div className="flex flex-col items-center gap-4">
              <div className="relative w-16 h-16">
                <div className="absolute inset-0 rounded-full border-2 border-purple-500/30 animate-ping" />
                <div className="absolute inset-2 rounded-full border-2 border-purple-400 border-t-transparent animate-spin" />
                <div className="absolute inset-0 flex items-center justify-center text-2xl">💬</div>
              </div>
              <span className="text-zinc-300 text-sm tracking-wide">AI 상담사 연결 중...</span>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-5">
              <div className="relative group cursor-pointer" onClick={startSession}>
                <div className="absolute -inset-1 bg-gradient-to-r from-purple-600 to-indigo-600 rounded-full blur opacity-60 group-hover:opacity-100 transition duration-500" />
                <div className="relative w-20 h-20 bg-zinc-900 rounded-full flex items-center justify-center border border-zinc-700 group-hover:border-purple-500 transition-all duration-300">
                  <svg className="w-8 h-8 text-purple-400 group-hover:text-white transition-colors duration-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                  </svg>
                </div>
              </div>
              <div className="text-center">
                <p className="text-white text-sm font-medium">대화를 시작하려면 터치하세요</p>
                <p className="text-zinc-500 text-xs mt-1">음성으로 질문할 수 있습니다</p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function InteractiveAvatarWrapper() {
  return (
    <StreamingAvatarProvider basePath={process.env.NEXT_PUBLIC_BASE_API_URL}>
      <InteractiveAvatar />
    </StreamingAvatarProvider>
  );
}
