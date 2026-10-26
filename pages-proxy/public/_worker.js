// Forwards everything to the workflwpro Worker, keeping the pages.dev URL the user sees.
export default {
  fetch(request, env) {
    return env.APP.fetch(request);
  },
};
