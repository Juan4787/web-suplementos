import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { getBusinessApi } from '@/services/business-api';

export const useBusinessQuery = <T>(
  options: Omit<UseQueryOptions<T, Error>, 'queryFn'> & { queryFn: (api: Awaited<ReturnType<typeof getBusinessApi>>) => Promise<T> }
) => {
  const { queryFn, ...queryOptions } = options;
  return useQuery<T, Error>({
    ...queryOptions,
    queryFn: async () => queryFn(await getBusinessApi())
  });
};

