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
          .json({
            error: "Unexpected model response format " +
                            "(JSON parse failed)",
          });
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

export const getWordCoreInfo = onRequest({region: "europe-west3"}, async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");

  const {knownLanguage, learnLanguage, knownWord, learnWord} = req.body;

  if (!knownLanguage || !learnLanguage || !knownWord || !learnWord) {
    res.status(400).json({error: "Missing required parameters"});
    return;
  }

  const prompt = `
I am a ${knownLanguage} speaker learning ${learnLanguage}.
Provide information about the ${learnLanguage} word "${learnWord}"
 (${knownWord} in ${knownLanguage}).
Return a single JSON object with the following properties:
- partOfSpeech: array of POS tags in ${learnLanguage}
- synonyms: array of a few close synonyms in ${learnLanguage}
- antonyms: array of a few antonyms if applicable in ${learnLanguage}
- examples: array with 2–3 objects { learnLanguageSentence, translation } 
where learnLanguageSentence is in ${learnLanguage} and the  translation is in ${knownLanguage}

Only output valid JSON and nothing else.
  `;

  try {
    const aiResponse = await ai.models.generateContent({
      model: model,
      contents: [
        {
          role: "user",
          parts: [{text: prompt}],
        },
      ],
      config: {
        temperature: 0.7,
        topP: 1,
        maxOutputTokens: 2048,
        responseMimeType: "application/json",
        responseSchema: {
          type: "object",
          properties: {
            partOfSpeech: {type: "array", items: {type: "string"}},
            synonyms: {type: "array", items: {type: "string"}},
            antonyms: {type: "array", items: {type: "string"}},
            examples: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  learnLanguageSentence: {type: "string"},
                  translation: {type: "string"},
                },
                required: ["learnLanguageSentence", "translation"],
              },
            },
          },
          required: ["partOfSpeech", "examples"],
        },
      },
    });

    // handle token limit
    const finishReason = aiResponse.candidates?.[0]?.finishReason;
    if (finishReason === "MAX_TOKENS") {
      res.status(500).json({error: "Max amount of tokens reached"});
      return;
    }

    // extract raw text (stringified JSON)
    const rawText = aiResponse.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) {
      res.status(500).json({error: "Output is empty"});
      return;
    }

    // parse JSON safely and validate shape
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (parseErr) {
      logger.error("Error parsing AI response:", parseErr);
      res.status(500).json({
        error: "Unexpected model response format (JSON parse failed)",
      });
      return;
    }

    // Validate it's an object and required fields exist
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      res
        .status(500)
        .json({error: "Unexpected model response format (expected object)"});
      return;
    }

    if (!Array.isArray(parsed.partOfSpeech) || !Array.isArray(parsed.examples)) {
      res.status(500).json({
        error:
                    "Unexpected model response format " +
            "(missing required fields: partOfSpeech/examples)",
      });
      return;
    }

    // Optional: ensure examples array items have required props
    const badExample = parsed.examples.find(
      (ex: { learnLanguageSentence: string; translation: string; }) =>
        !ex ||
                typeof ex.learnLanguageSentence !== "string" ||
                typeof ex.translation !== "string"
    );
    if (badExample) {
      res.status(500).json({
        error:
                    "Unexpected model response format" +
            " (examples must contain learnLanguageSentence and translation strings)",
      });
      return;
    }

    // All good — return single word object
    res.json(parsed);
  } catch (err) {
    logger.error("Error generating word info:", err);
    res.status(500).json({error: "Failed to fetch word info"});
  }
});
