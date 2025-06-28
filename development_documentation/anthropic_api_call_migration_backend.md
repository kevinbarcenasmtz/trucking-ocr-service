# Migration of Frontend Anthropic API calls to the Backend

The AIClassificationService.ts in the trucklogistics repository currently holds the logic for the the Anthropic API calls.

First need to add the Anthropic SDK to the backend

```bash
npm install @anthropic-ai/sdk
```

The rest of the migration results in adding a new endpoint to server.js, changing the frontend file to call that endpoint. Adding environment variables to the backend and Heroku configuration.
