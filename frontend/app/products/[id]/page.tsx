import { redirect } from 'next/navigation';

export default function ProductDetailRedirect({ params }: { params: { id: string } }) {
  redirect(`/catalog?productId=${encodeURIComponent(params.id)}`);
}
