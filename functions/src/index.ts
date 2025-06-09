import {onRequest} from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import {Translate} from "@google-cloud/translate/build/src/v2";
import {GoogleGenAI} from "@google/genai";

const translate = new Translate();

// eslint-disable-next-line require-jsdoc
async function translateText(
  text: string,
  knownLanguage: string,
  learnLanguage: string
): Promise<string[]> {
  const [translationResponse] = await translate.translate(text, {
    from: knownLanguage,
    to: learnLanguage,
  });
  return Array.isArray(translationResponse) ?
    translationResponse :
    [translationResponse];
}

export const translateFunction = onRequest(
  {region: "europe-west3"}, // here you define the region!
  async (request, response) => {
    response.set("Access-Control-Allow-Origin", "*");
    response.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.set("Access-Control-Allow-Headers", "Content-Type");

    // Handle preflight request
    if (request.method === "OPTIONS") {
      response.status(204).send("");
      return;
    }

    const text = request.query.text as string | undefined;
    const knownLanguage = request.query.knownLanguage as string | undefined;
    const learnLanguage = request.query.learnLanguage as string | undefined;

    if (!text || !knownLanguage || !learnLanguage) {
      response.status(400).send("Missing query parameters");
      return;
    }

    try {
      const translatedText = await translateText(
        text,
        knownLanguage,
        learnLanguage
      );
      response.json({translated: translatedText});
    } catch (err) {
      logger.error("Translation error", err);
      response.status(500).send("Translation error");
    }
  }
);

const ai = new GoogleGenAI({
  vertexai: true,
  project: "vocli-ab84e",
  location: "global",
});

const model = "gemini-2.0-flash";

// eslint-disable-next-line require-jsdoc
function buildPrompt(
  mode: string,
  knownLanguage: string,
  learnLanguage: string,
  inputText: string,
  amount: number
): string {
  if (mode === "generate") {
    return `
Generate ${amount} vocabulary word pairs related to the topic: "${inputText}".
The user knows ${knownLanguage} and wants to learn ${learnLanguage}.
Respond as a JSON array of objects with this format:
[
  { "from": "<word in ${knownLanguage}>", "to": "<word in ${learnLanguage}>" },
  ...
]
Output MUST be clean and ready for language practice — avoid dashes, commas, or 
punctuation. Only include vocabulary suitable for typing exercises.
Return only the array.
`;
  } else if (mode === "raw") {
    return `
Extract useful vocabulary words from the following unstructured text:
"${inputText}"

Translate each word or phrase from ${knownLanguage} to ${learnLanguage}.

Respond ONLY with a JSON array like:
[
  { "from": "<word in ${knownLanguage}>", "to": "<word in ${learnLanguage}>" },
  ...
]

Output MUST be clean and ready for language practice — avoid 
dashes, commas, or punctuation. Only include vocabulary suitable 
for typing exercises.
`;
  } else {
    throw new Error("Invalid mode");
  }
}

export const importVocabularyFunction = onRequest(
  {region: "europe-west3"},
  async (request, response) => {
    response.set("Access-Control-Allow-Origin", "*");
    response.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.set("Access-Control-Allow-Headers", "Content-Type");

    // Handle preflight request
    if (request.method === "OPTIONS") {
      response.status(204).send("");
      return;
    }

    const mode = request.query.mode as string | undefined;
    const knownLanguage = request.query.knownLanguage as string | undefined;
    const learnLanguage = request.query.learnLanguage as string | undefined;
    const inputText = request.query.inputText as string | undefined;
    const amount = parseInt((request.query.amount as string) || "10");

    if (!mode || !knownLanguage || !learnLanguage || !inputText) {
      response.status(400).send("Missing query parameters");
      return;
    }

    try {
      const prompt = buildPrompt(
        mode,
        knownLanguage,
        learnLanguage,
        inputText,
        amount
      );

      const aiResponse = await ai.models.generateContent({
        model,
        contents: [
          {
            role: "user",
            parts: [{text: prompt}],
          },
        ],
        config: {
          temperature: 0.8,
          topP: 1,
          maxOutputTokens: 8192,
          responseMimeType: "application/json",
          responseSchema: {
            type: "array",
            items: {
              type: "object",
              properties: {
                from: {type: "string"},
                to: {type: "string"},
              },
              required: ["from", "to"],
            },
          },
        },
      });

      if (aiResponse.candidates?.[0]?.finishReason === "MAX_TOKENS") {
        response.status(500).json({error: "Max amount of tokens reached"});
        return;
      }

      const wordList = aiResponse.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!wordList) {
        response.status(500).json({error: "Output is empty"});
        return;
      }

      let parsedWords;
      try {
        parsedWords = JSON.parse(wordList);
      } catch (parseErr) {
        logger.error("Error parsing AI response:", parseErr);
        response
          .status(500)
          .json({error: "Unexpected model response format " +
                  "(JSON parse failed)"});
        return;
      }

      if (!Array.isArray(parsedWords)) {
        response
          .status(500)
          .json({error: "Unexpected model response format (not an array)"});
        return;
      }

      response.json({words: parsedWords});
    } catch (err) {
      logger.error("Error generating vocabulary:", err);
      response.status(500).send("Vocabulary generation error");
    }
  }
);
