"use client";
import { Button, Card, EmptyState } from "@/components/ui";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <Card>
      <EmptyState icon="alert" title="Something went wrong on this page" body={`Nothing was changed. ${error.digest ? `Reference: ${error.digest}` : "Try again."}`} action={<Button variant="primary" onClick={reset}>Try again</Button>} />
    </Card>
  );
}
