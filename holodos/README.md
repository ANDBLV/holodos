# холодОС ❄️

AI-приложение: фотографируете холодильник → распознаются продукты → подбираются рецепты из того, что уже есть дома.

Стек: **React + Vite** (фронтенд) и **Vercel Serverless Function** (`/api/claude`) — безопасный прокси к Anthropic API. API-ключ хранится только на сервере и никогда не попадает в браузер.

## Структура

```
holodos/
├── api/claude.js      ← serverless-прокси к Anthropic API (ключ из env)
├── src/
│   ├── App.jsx        ← всё приложение
│   ├── index.css      ← стили
│   └── main.jsx
├── index.html
├── package.json
├── vite.config.js
└── .env.example
```

## Деплой на Vercel (5 минут)

1. **Получите API-ключ** на https://console.anthropic.com/ → API Keys.

2. **Загрузите проект на GitHub** (или GitLab/Bitbucket):
   ```bash
   cd holodos
   git init && git add . && git commit -m "холодОС"
   git remote add origin https://github.com/ВАШ_ЛОГИН/holodos.git
   git push -u origin main
   ```

3. **Импортируйте в Vercel**: https://vercel.com/new → выберите репозиторий. Vercel сам определит Vite, ничего менять не нужно.

4. **Добавьте переменную окружения** перед деплоем (или потом в Settings → Environment Variables):
   - Name: `ANTHROPIC_API_KEY`
   - Value: ваш ключ `sk-ant-...`

5. Нажмите **Deploy**. Готово — приложение будет доступно по адресу вида `https://holodos.vercel.app`.

### Альтернатива: деплой через CLI без GitHub

```bash
npm i -g vercel
cd holodos
npm install
vercel                        # первый деплой, ответьте на вопросы
vercel env add ANTHROPIC_API_KEY   # вставьте ключ, выберите все окружения
vercel --prod
```

## Локальная разработка

Serverless-функции не работают в чистом `vite dev`, поэтому локально запускайте через Vercel CLI:

```bash
npm install
cp .env.example .env          # впишите свой ключ
npx vercel dev                # поднимет и фронтенд, и /api/claude
```

## Настройки: два провайдера на выбор

Приложение работает с любым из трёх AI-провайдеров — задайте ОДИН ключ:

| Переменная | Описание |
|---|---|
| `ANTHROPIC_API_KEY` | Claude (Anthropic), платный. Ключ: console.anthropic.com/settings/keys |
| `GEMINI_API_KEY` | Google Gemini, есть бесплатный тариф без карты. Ключ: aistudio.google.com → Get API key |
| `OPENROUTER_API_KEY` | OpenRouter, бесплатные модели «:free» (50 запросов/день). Ключ: openrouter.ai → Keys |
| `OPENROUTER_MODEL` | Необязательно, по умолчанию `openrouter/free (роутер сам выберет доступную бесплатную модель)` |
| `ANTHROPIC_MODEL` | Необязательно, по умолчанию `claude-sonnet-4-6` |
| `GEMINI_MODEL` | Необязательно, по умолчанию `gemini-3.8-flash` |

Если задано несколько ключей, приоритет: Claude → Gemini → OpenRouter. На бесплатном тарифе Gemini действуют
лимиты запросов в минуту/день, и Google может использовать запросы для обучения
моделей — для личного пользования и демо этого достаточно.

## Что стоит добавить перед публичным запуском

- **Лимит запросов** в `api/claude.js` (например, по IP через Vercel KV/Upstash) — иначе кто угодно сможет расходовать ваш API-бюджет.
- **Домен-проверку** (заголовок Origin), если приложение публичное.
- Историю рецептов и список покупок из блока «докупить».
