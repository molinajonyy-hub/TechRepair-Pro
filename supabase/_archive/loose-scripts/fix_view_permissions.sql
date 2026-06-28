-- Grant permissions for business_users_view
GRANT SELECT ON public.business_users_view TO authenticated;

-- Grant permissions for other views if they exist
GRANT SELECT ON public.businesses TO authenticated;
GRANT SELECT ON public.profiles TO authenticated;
GRANT SELECT ON public.business_invitations TO authenticated;
