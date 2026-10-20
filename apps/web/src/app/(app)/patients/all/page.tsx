import { redirect } from 'next/navigation';

/**
 * The old "All patients" screen, now part of `/patients`.
 *
 * A REDIRECT RATHER THAN A DELETION, because this route is in people's
 * bookmarks and in the browser history of every receptionist who has used the
 * system — and because `?page=4` means something there. Dropping it would turn
 * a bookmark into a 404 for a page that very much still exists.
 *
 * The page number is carried across, so a bookmarked page 4 is still page 4.
 */
export default async function AllPatientsRedirect({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { page } = await searchParams;
  redirect(page ? `/patients?page=${encodeURIComponent(page)}` : '/patients');
}
