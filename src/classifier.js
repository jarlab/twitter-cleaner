// Your classifier. Edit the questions and the decision rule; everything else stays the same.
//
// Question types (https://docs.typesafe.ai/api.md):
//   noul   -> yes/no,        answer.noul is 0..1
//   choice -> pick one,      answer.choice + answer.probabilities
//   score  -> rubric levels, answer.score (0..levels-1, can be fractional)

export const model = 'jev-latest';

export const questions = {
  not_interested: {
    type: 'noul',
    instructions:
      "This post is something I don't want in my feed: engagement bait, rage bait, " +
      'low-effort viral filler, giveaway/crypto spam, or drama about people I do not follow.',
    criteria: {
      true: 'Low-value post I would rather not see',
      false: 'Genuinely informative, thoughtful, funny, or from a conversation I care about',
    },
  },
};

// Given Jev's answers for one post, return true to click "Not interested in this post".
export function shouldHide(answers) {
  return answers.not_interested.noul >= 0.7;
}
