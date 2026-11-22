import { useState, useRef, useCallback, useEffect } from "react";

// ─────────────────────────────────────────────────────────────
// холодОС — фото холодильника → ингредиенты → рецепты
// Запросы к AI идут через серверный прокси /api/claude,
// чтобы API-ключ не попадал в браузер.
// ─────────────────────────────────────────────────────────────

const LOADING_SCAN = [
  "Заглядываю на полки…",
  "Отодвигаю банку с огурцами…",
  "Проверяю, что прячется за кетчупом…",
  "Считаю яйца…",
];
const LOADING_COOK = [
  "Листаю поваренную книгу…",
  "Советуюсь с шеф-поваром…",
  "Прикидываю, что с чем сочетается…",
  "Пробую на вкус…",
];

function stripFences(text) {
  return text.replace(/```json|```/g, "").trim();
}

async function callClaude(messages, maxTokens = 1500) {
  const response = await fetch("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, max_tokens: maxTokens }),
  });
  if (!response.ok) throw new Error("api");
  const data = await response.json();
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return JSON.parse(stripFences(text));
}

// Сжимаем фото до разумного размера перед отправкой
function fileToBase64(file, maxSide = 1280) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
      URL.revokeObjectURL(url);
      resolve({ base64: dataUrl.split(",")[1], preview: dataUrl });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("img"));
    };
    img.src = url;
  });
}

const DIETS = [
  { id: "any", label: "Ем всё" },
  { id: "veg", label: "Вегетарианское" },
  { id: "vegan", label: "Веганское" },
];
const TIMES = [
  { id: "any", label: "Любое время" },
  { id: "15", label: "До 15 мин" },
  { id: "30", label: "До 30 мин" },
  { id: "60", label: "До часа" },
];
const LEVELS = [
  { id: "any", label: "Любая сложность" },
  { id: "easy", label: "Совсем просто" },
  { id: "medium", label: "Готовлю уверенно" },
];

export default function App() {
  const [photo, setPhoto] = useState(null); // { base64, preview }
  const [ingredients, setIngredients] = useState(null); // [{name, emoji}]
  const [recipes, setRecipes] = useState(null);
  const [phase, setPhase] = useState("start"); // start | scanning | edit | cooking | done
  const [error, setError] = useState(null);
  const [loadingMsg, setLoadingMsg] = useState("");
  const [openRecipe, setOpenRecipe] = useState(0);
  const [newItem, setNewItem] = useState("");
  const [diet, setDiet] = useState("any");
  const [time, setTime] = useState("any");
  const [level, setLevel] = useState("any");
  const [allergies, setAllergies] = useState("");
  const [cameraOn, setCameraOn] = useState(false);
  const fileRef = useRef(null);
  const msgTimer = useRef(null);
  const videoRef = useRef(null);
  const streamRef = useRef(null);

  const startLoadingMsgs = (list) => {
    let i = 0;
    setLoadingMsg(list[0]);
    clearInterval(msgTimer.current);
    msgTimer.current = setInterval(() => {
      i = (i + 1) % list.length;
      setLoadingMsg(list[i]);
    }, 2200);
  };
  const stopLoadingMsgs = () => clearInterval(msgTimer.current);

  const analyzeImage = useCallback(
    async (img) => {
      setError(null);
      setRecipes(null);
      setPhase("scanning");
      startLoadingMsgs(LOADING_SCAN);
      try {
        setPhoto(img);
        const result = await callClaude([
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/jpeg",
                  data: img.base64,
                },
              },
              {
                type: "text",
                text:
                  "На фото — содержимое холодильника или продукты. Определи, какие продукты и ингредиенты видны. " +
                  "Отвечай ТОЛЬКО валидным JSON без пояснений и без markdown, строго в формате: " +
                  '{"is_food": true, "ingredients": [{"name": "название по-русски, коротко", "emoji": "один подходящий эмодзи"}]} ' +
                  'Если на фото нет еды, верни {"is_food": false, "ingredients": []}. ' +
                  "Называй продукты обобщённо (например «молоко», «помидоры», «куриное филе»), не выдумывай то, чего не видно, максимум 20 позиций.",
              },
            ],
          },
        ]);
        stopLoadingMsgs();
        if (!result.is_food || !result.ingredients?.length) {
          setPhase("start");
          setPhoto(null);
          setError(
            "Еда на фото не нашлась. Попробуйте снять полки холодильника поближе и при свете."
          );
          return;
        }
        setIngredients(result.ingredients);
        setPhase("edit");
      } catch (e) {
        stopLoadingMsgs();
        setPhase(ingredients ? "edit" : "start");
        setError("Не получилось разобрать фото. Проверьте соединение и попробуйте ещё раз.");
      }
    },
    [ingredients]
  );

  const handleFile = useCallback(
    async (file) => {
      if (!file) return;
      try {
        const img = await fileToBase64(file);
        await analyzeImage(img);
      } catch (e) {
        setError("Не получилось открыть файл. Попробуйте другое фото.");
      }
    },
    [analyzeImage]
  );

  // ── Живая камера в приложении ──
  const closeCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCameraOn(false);
  }, []);

  useEffect(() => closeCamera, [closeCamera]); // выключаем камеру при размонтировании

  const openCamera = async () => {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      fileRef.current?.click(); // браузер без камеры — системный выбор файла
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      streamRef.current = stream;
      setCameraOn(true);
      requestAnimationFrame(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
      });
    } catch (e) {
      // доступ не дали или камеры нет — падаем на выбор файла
      fileRef.current?.click();
    }
  };

  const capture = async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const maxSide = 1280;
    const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    closeCamera();
    await analyzeImage({ base64: dataUrl.split(",")[1], preview: dataUrl });
  };

  const removeIngredient = (idx) =>
    setIngredients((list) => list.filter((_, i) => i !== idx));

  const addIngredient = () => {
    const name = newItem.trim();
    if (!name) return;
    setIngredients((list) => [...list, { name, emoji: "🧺" }]);
    setNewItem("");
  };

  const getRecipes = async () => {
    setError(null);
    setPhase("cooking");
    startLoadingMsgs(LOADING_COOK);
    const filters = [];
    if (diet === "veg") filters.push("только вегетарианские блюда (без мяса и рыбы)");
    if (diet === "vegan")
      filters.push("только веганские блюда (без продуктов животного происхождения)");
    if (time !== "any") filters.push(`время готовки не больше ${time} минут`);
    if (level === "easy") filters.push("очень простые рецепты для новичка");
    if (level === "medium") filters.push("сложность не выше средней");
    if (allergies.trim())
      filters.push(`исключи аллергены и продукты: ${allergies.trim()}`);
    try {
      const result = await callClaude(
        [
          {
            role: "user",
            content:
              `Вот продукты, которые есть у человека дома: ${ingredients
                .map((i) => i.name)
                .join(", ")}. ` +
              (filters.length ? `Ограничения: ${filters.join("; ")}. ` : "") +
              "Предложи 3 блюда, которые реально приготовить в основном из этих продуктов. Базовые вещи (соль, перец, масло, вода) считай всегда доступными. " +
              "Отвечай ТОЛЬКО валидным JSON без markdown, строго в формате: " +
              '{"recipes": [{"title": "название", "emoji": "эмодзи", "minutes": 25, "level": "просто|средне|сложно", ' +
              '"uses": ["продукты из списка, которые используются"], "missing": ["чего не хватает, если что-то нужно докупить — или пустой массив"], ' +
              '"steps": ["короткий шаг 1", "шаг 2", "..."], "tip": "один совет от шефа"}]} ' +
              "Шагов 4–7, формулировки короткие и дружелюбные, всё по-русски.",
          },
        ],
        2000
      );
      stopLoadingMsgs();
      setRecipes(result.recipes || []);
      setOpenRecipe(0);
      setPhase("done");
    } catch (e) {
      stopLoadingMsgs();
      setPhase("edit");
      setError("Рецепты не приготовились с первого раза. Попробуйте ещё раз.");
    }
  };

  const reset = () => {
    setPhoto(null);
    setIngredients(null);
    setRecipes(null);
    setError(null);
    setPhase("start");
    if (fileRef.current) fileRef.current.value = "";
  };

  const busy = phase === "scanning" || phase === "cooking";

  return (
    <div className="hos-root">
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: "none" }}
        onChange={(e) => handleFile(e.target.files?.[0])}
      />

      {/* ────────── Живой видоискатель ────────── */}
      {cameraOn && (
        <div className="hos-camera" role="dialog" aria-label="Камера">
          <video ref={videoRef} playsInline muted autoPlay />
          <div className="hos-camera-frame" aria-hidden="true" />
          <div className="hos-camera-bar">
            <button className="hos-camera-cancel" onClick={closeCamera}>
              Отмена
            </button>
            <button className="hos-shutter" onClick={capture} aria-label="Сделать снимок" />
            <span className="hos-camera-spacer" aria-hidden="true" />
          </div>
        </div>
      )}

      <header className="hos-header">
        <div
          className="hos-logo"
          onClick={reset}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === "Enter" && reset()}
        >
          холод<span className="hos-logo-os">ОС</span>
          <span className="hos-deg">−4°</span>
        </div>
        {phase !== "start" && (
          <button className="hos-ghost-btn" onClick={reset}>
            Новое фото
          </button>
        )}
      </header>

      {/* ────────── Старт ────────── */}
      {phase === "start" && (
        <main className="hos-main">
          <h1 className="hos-hero">
            Что приготовить
            <br />
            из того, что уже
            <br />в холодильнике?
          </h1>
          <p className="hos-sub">
            Сфотографируйте полки — распознаю продукты и предложу блюда без похода в
            магазин.
          </p>
          <div className="hos-cta-row">
            <button className="hos-cta" onClick={openCamera}>
              📸 Открыть камеру
            </button>
            <button className="hos-ghost-btn" onClick={() => fileRef.current?.click()}>
              Выбрать фото из галереи
            </button>
          </div>
          <p className="hos-hint">
            Камера работает прямо в браузере — разрешите доступ, наведите на полки и нажмите
            кнопку съёмки.
          </p>
          {error && <div className="hos-error">{error}</div>}
          <div className="hos-how">
            <div className="hos-how-item">
              <span>1</span>Фото полок
            </div>
            <div className="hos-how-arrow">→</div>
            <div className="hos-how-item">
              <span>2</span>Список продуктов
            </div>
            <div className="hos-how-arrow">→</div>
            <div className="hos-how-item">
              <span>3</span>Рецепты на ужин
            </div>
          </div>
        </main>
      )}

      {/* ────────── Загрузка ────────── */}
      {busy && (
        <main className="hos-main hos-center">
          {photo && <img src={photo.preview} alt="Ваше фото" className="hos-thumb" />}
          <div className="hos-snow">❄</div>
          <p className="hos-loading">{loadingMsg}</p>
        </main>
      )}

      {/* ────────── Дверца холодильника: продукты ────────── */}
      {phase === "edit" && ingredients && (
        <main className="hos-main">
          <h2 className="hos-h2">Нашлось на полках</h2>
          <p className="hos-sub-s">
            Уберите лишнее или добавьте то, что я не разглядел — магнитики можно снимать.
          </p>

          <div className="hos-fridge">
            <div className="hos-handle" aria-hidden="true" />
            <div className="hos-magnets">
              {ingredients.map((ing, i) => (
                <button
                  key={i}
                  className="hos-magnet"
                  onClick={() => removeIngredient(i)}
                  title="Убрать"
                >
                  <span className="hos-magnet-emoji">{ing.emoji}</span>
                  {ing.name}
                  <span className="hos-magnet-x">×</span>
                </button>
              ))}
              <div className="hos-add">
                <input
                  value={newItem}
                  onChange={(e) => setNewItem(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addIngredient()}
                  placeholder="добавить продукт"
                />
                <button onClick={addIngredient} aria-label="Добавить">
                  +
                </button>
              </div>
            </div>
          </div>

          <h2 className="hos-h2">Под себя</h2>
          <div className="hos-filters">
            <FilterRow options={DIETS} value={diet} onChange={setDiet} />
            <FilterRow options={TIMES} value={time} onChange={setTime} />
            <FilterRow options={LEVELS} value={level} onChange={setLevel} />
            <input
              className="hos-allergy"
              value={allergies}
              onChange={(e) => setAllergies(e.target.value)}
              placeholder="Аллергии или нелюбимое: например, орехи, грибы"
            />
          </div>

          {error && <div className="hos-error">{error}</div>}
          <button className="hos-cta" onClick={getRecipes} disabled={!ingredients.length}>
            🍳 Подобрать рецепты
          </button>
        </main>
      )}

      {/* ────────── Рецепты ────────── */}
      {phase === "done" && recipes && (
        <main className="hos-main">
          <h2 className="hos-h2">Можно приготовить сегодня</h2>
          {recipes.length === 0 && (
            <p className="hos-sub-s">
              Из этого набора ничего не собралось. Добавьте пару продуктов и попробуйте
              снова.
            </p>
          )}
          <div className="hos-recipes">
            {recipes.map((r, i) => (
              <article key={i} className={`hos-recipe ${openRecipe === i ? "open" : ""}`}>
                <button
                  className="hos-recipe-head"
                  onClick={() => setOpenRecipe(openRecipe === i ? -1 : i)}
                >
                  <span className="hos-recipe-emoji">{r.emoji}</span>
                  <span className="hos-recipe-title">{r.title}</span>
                  <span className="hos-recipe-meta">
                    ⏱ {r.minutes} мин · {r.level}
                  </span>
                  <span className="hos-recipe-chevron">{openRecipe === i ? "–" : "+"}</span>
                </button>
                {openRecipe === i && (
                  <div className="hos-recipe-body">
                    <div className="hos-uses">
                      {r.uses?.map((u, k) => (
                        <span key={k} className="hos-tag">
                          {u}
                        </span>
                      ))}
                      {r.missing?.map((m, k) => (
                        <span key={k} className="hos-tag miss">
                          докупить: {m}
                        </span>
                      ))}
                    </div>
                    <ol className="hos-steps">
                      {r.steps?.map((s, k) => (
                        <li key={k}>{s}</li>
                      ))}
                    </ol>
                    {r.tip && <p className="hos-tip">Совет шефа: {r.tip}</p>}
                  </div>
                )}
              </article>
            ))}
          </div>
          <div className="hos-again">
            <button className="hos-ghost-btn" onClick={() => setPhase("edit")}>
              ← Изменить продукты
            </button>
            <button className="hos-ghost-btn" onClick={getRecipes}>
              Другие варианты
            </button>
          </div>
        </main>
      )}

      <footer className="hos-footer">холодОС · рецепты из того, что есть</footer>
    </div>
  );
}

function FilterRow({ options, value, onChange }) {
  return (
    <div className="hos-filter-row">
      {options.map((o) => (
        <button
          key={o.id}
          className={`hos-pill ${value === o.id ? "active" : ""}`}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
