"use client";

import { useEffect, useState, type FormEvent } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { IconEye, IconEyeOff } from "@/lib/icons";
import { easeOutSoft } from "@/lib/motion";

type JoinGateProps = {
  connected: boolean;
  error?: string | null;
  onRegister: (username: string, password: string) => void;
  onLogin: (username: string, password: string) => void;
};

type AuthMode = "login" | "register";

export function JoinGate({
  connected,
  error,
  onRegister,
  onLogin,
}: JoinGateProps) {
  const reduceMotion = useReducedMotion();
  const [mode, setMode] = useState<AuthMode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (error) setSubmitting(false);
  }, [error]);

  useEffect(() => {
    if (!submitting) return;
    const timer = window.setTimeout(() => {
      setSubmitting(false);
      setLocalError((prev) => prev || "Сервер не ответил. Попробуйте ещё раз");
    }, 12_000);
    return () => window.clearTimeout(timer);
  }, [submitting]);

  useEffect(() => {
    if (!connected) setSubmitting(false);
  }, [connected]);

  function handleAuth(event: FormEvent) {
    event.preventDefault();
    if (!connected) {
      setLocalError("Нет соединения с сервером");
      return;
    }
    if (submitting) return;
    setLocalError(null);

    if (mode === "register") {
      if (password.length < 8) {
        setLocalError("Пароль от 8 символов");
        return;
      }
      if (password !== confirm) {
        setLocalError("Пароли не совпадают");
        return;
      }
      setSubmitting(true);
      onRegister(username.trim(), password);
      return;
    }

    if (!username.trim()) {
      setLocalError("Введите логин");
      return;
    }
    if (!password) {
      setLocalError("Введите пароль");
      return;
    }

    setSubmitting(true);
    onLogin(username.trim(), password);
  }

  const d = reduceMotion ? 0 : 1;

  return (
    <div className="join">
      <motion.section
        className="join__hero"
        initial={reduceMotion ? false : { opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.55 * d, ease: easeOutSoft }}
      >
        <div className="join__hero-pulse" aria-hidden>
          <span />
          <span />
          <span />
        </div>

        <motion.p
          className="join__brand"
          initial={reduceMotion ? false : { opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 * d, delay: 0.05 * d, ease: easeOutSoft }}
        >
          Pulse
        </motion.p>

        <motion.h1
          className="join__title"
          initial={reduceMotion ? false : { opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55 * d, delay: 0.14 * d, ease: easeOutSoft }}
        >
          Чат без лишнего
        </motion.h1>

        <motion.p
          className="join__lead"
          initial={reduceMotion ? false : { opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 * d, delay: 0.22 * d, ease: easeOutSoft }}
        >
          Личные сообщения, группы, файлы и звонки — спокойно и по делу.
        </motion.p>

        <motion.ul
          className="join__points"
          initial="hidden"
          animate="show"
          variants={{
            hidden: {},
            show: {
              transition: {
                staggerChildren: 0.07 * d,
                delayChildren: 0.3 * d,
              },
            },
          }}
        >
          {["Профиль и аватар", "ЛС и групповые чаты", "Аудио и видеозвонки"].map(
            (item) => (
              <motion.li
                key={item}
                variants={{
                  hidden: { opacity: 0, y: 8 },
                  show: {
                    opacity: 1,
                    y: 0,
                    transition: { duration: 0.4 * d, ease: easeOutSoft },
                  },
                }}
              >
                {item}
              </motion.li>
            ),
          )}
        </motion.ul>
      </motion.section>

      <motion.section
        className="join__panel"
        initial={reduceMotion ? false : { opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.55 * d, delay: 0.18 * d, ease: easeOutSoft }}
      >
        <div className="auth-tabs" role="tablist" aria-label="Вход или регистрация">
          <button
            type="button"
            role="tab"
            id="tab-login"
            aria-controls="auth-panel"
            aria-selected={mode === "login"}
            className={`auth-tabs__btn ${mode === "login" ? "is-active" : ""}`}
            onClick={() => {
              setMode("login");
              setLocalError(null);
              setSubmitting(false);
            }}
          >
            Вход
          </button>
          <button
            type="button"
            role="tab"
            id="tab-register"
            aria-controls="auth-panel"
            aria-selected={mode === "register"}
            className={`auth-tabs__btn ${mode === "register" ? "is-active" : ""}`}
            onClick={() => {
              setMode("register");
              setLocalError(null);
              setSubmitting(false);
            }}
          >
            Регистрация
          </button>
        </div>

        <form
          id="auth-panel"
          role="tabpanel"
          aria-labelledby={mode === "login" ? "tab-login" : "tab-register"}
          className="join__form"
          onSubmit={handleAuth}
        >
          <label className="field">
            <span>Логин</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="artem"
              maxLength={24}
              autoFocus
              required
              autoComplete="username"
              disabled={submitting}
            />
          </label>

          <label className="field">
            <span>Пароль</span>
            <div className="field__password">
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="••••"
                minLength={8}
                required
                aria-invalid={Boolean(localError || error) || undefined}
                autoComplete={
                  mode === "register" ? "new-password" : "current-password"
                }
                disabled={submitting}
              />
              <button
                type="button"
                className="field__toggle"
                onClick={() => setShowPassword((value) => !value)}
                aria-label={showPassword ? "Скрыть пароль" : "Показать пароль"}
                title={showPassword ? "Скрыть пароль" : "Показать пароль"}
              >
                {showPassword ? <IconEyeOff size={16} /> : <IconEye size={16} />}
              </button>
            </div>
          </label>

          <AnimatePresence initial={false}>
            {mode === "register" && (
              <motion.label
                className="field"
                initial={{ opacity: 0, height: 0, y: -4 }}
                animate={{ opacity: 1, height: "auto", y: 0 }}
                exit={{ opacity: 0, height: 0, y: -4 }}
                transition={{ duration: 0.28, ease: easeOutSoft }}
              >
                <span>Повторите пароль</span>
                <input
                  type={showPassword ? "text" : "password"}
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                  placeholder="••••"
                  minLength={8}
                  required
                  autoComplete="new-password"
                  disabled={submitting}
                />
              </motion.label>
            )}
          </AnimatePresence>

          <AnimatePresence initial={false}>
            {(localError || error) && (
              <motion.p
                className="join__error"
                role="alert"
                initial={{ opacity: 0, y: -4, height: 0 }}
                animate={{ opacity: 1, y: 0, height: "auto" }}
                exit={{ opacity: 0, y: -4, height: 0 }}
                transition={{ duration: 0.24, ease: easeOutSoft }}
              >
                {localError || error}
              </motion.p>
            )}
          </AnimatePresence>

          <button
            className={`join__cta ${submitting ? "is-busy" : ""}`}
            type="submit"
            disabled={!connected || submitting}
          >
            {submitting && <i className="join__cta-spin" aria-hidden />}
            {!connected
              ? "Подключение…"
              : submitting
                ? mode === "register"
                  ? "Создаём…"
                  : "Входим…"
                : mode === "register"
                  ? "Создать аккаунт"
                  : "Войти"}
          </button>
        </form>
      </motion.section>
    </div>
  );
}
